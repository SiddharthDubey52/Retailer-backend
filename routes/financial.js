// /api/financial — 4-digit financial security PIN and short-lived financial access.
// Never logs or returns the PIN or its hash.
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { User, UserSecurity } from '../models/index.js'
import {
  financialAccess, grantFinancialAccess, hashPin, LOCKOUT_MS, MAX_FAILED_ATTEMPTS, PIN_PATTERN,
  pinMatches, revokeFinancialAccess, safeEqual,
} from '../services/financialAccess.js'
import { writeAudit } from '../utils.js'

const router = Router()
const pin = z.string().regex(PIN_PATTERN)
const PIN_FORMAT = 'The PIN must be exactly 4 digits.'
const INCORRECT = 'Incorrect PIN.'
const TOO_MANY = 'Too many incorrect attempts. Try again later.'

// Per-IP limit on top of the per-account lockout below.
const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.FINANCIAL_PIN_RATE_LIMIT) || 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED', message: TOO_MANY },
})

const audit = (request, action) => writeAudit(request.user._id, action, 'User', request.user._id, { ip: request.ip }).catch(() => {})

async function loadSecurity(userId) {
  return UserSecurity.findOneAndUpdate({ user: userId }, { $setOnInsert: { user: userId } }, { upsert: true, new: true }).select('+financialPinHash')
}

async function passwordMatches(userId, password) {
  const user = await User.findById(userId).select('+passwordHash')
  return Boolean(user && typeof password === 'string' && password && await bcrypt.compare(password, user.passwordHash))
}

/** Checks a PIN with lockout. Returns null on success, or { status, body } to send. */
async function checkPin(request, security, candidate) {
  if (security.lockedUntil && security.lockedUntil > new Date()) {
    await audit(request, 'FINANCIAL_PIN_LOCKED_ATTEMPT')
    return { status: 429, body: { code: 'PIN_LOCKED', message: TOO_MANY, retryAfter: security.lockedUntil } }
  }
  if (await pinMatches(candidate, security.financialPinHash)) {
    if (security.failedAttempts || security.lockedUntil) await UserSecurity.updateOne({ _id: security._id }, { $set: { failedAttempts: 0, lockedUntil: null } })
    return null
  }
  const updated = await UserSecurity.findOneAndUpdate({ _id: security._id }, { $inc: { failedAttempts: 1 } }, { new: true })
  await audit(request, 'FINANCIAL_PIN_FAILED')
  if (updated.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_MS)
    await UserSecurity.updateOne({ _id: security._id }, { $set: { failedAttempts: 0, lockedUntil, financialSession: null } })
    await audit(request, 'FINANCIAL_PIN_LOCKOUT')
    return { status: 429, body: { code: 'PIN_LOCKED', message: TOO_MANY, retryAfter: lockedUntil } }
  }
  return { status: 401, body: { code: 'PIN_INCORRECT', message: INCORRECT } }
}

router.get('/status', async (request, response, next) => {
  try {
    const [security, access] = await Promise.all([UserSecurity.findOne({ user: request.user._id }).lean(), financialAccess(request)])
    const locked = security?.lockedUntil && security.lockedUntil > new Date()
    response.json({
      pinEnabled: Boolean(security?.pinEnabled),
      unlocked: Boolean(security?.pinEnabled && access.granted),
      expiresAt: security?.pinEnabled && access.granted ? access.expiresAt : null,
      lockedUntil: locked ? security.lockedUntil : null,
    })
  } catch (error) { next(error) }
})

// First-time setup: needs the account password so a staff member using the logged-in app cannot set it.
router.post('/pin', pinLimiter, async (request, response, next) => {
  try {
    const parsed = z.object({ password: z.string().min(1), pin, confirmPin: pin }).safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_FORMAT', message: `Enter your account password. ${PIN_FORMAT}` })
    if (parsed.data.pin !== parsed.data.confirmPin) return response.status(400).json({ code: 'PIN_MISMATCH', message: 'The two PINs do not match.' })
    const security = await loadSecurity(request.user._id)
    if (security.pinEnabled) return response.status(409).json({ code: 'PIN_EXISTS', message: 'A PIN is already set. Use Change PIN instead.' })
    if (!(await passwordMatches(request.user._id, parsed.data.password))) {
      await audit(request, 'FINANCIAL_PIN_SETUP_BAD_PASSWORD')
      return response.status(401).json({ code: 'PASSWORD_INCORRECT', message: 'The account password is incorrect.' })
    }
    await UserSecurity.updateOne({ _id: security._id }, {
      $set: { financialPinHash: await hashPin(parsed.data.pin), pinEnabled: true, pinUpdatedAt: new Date(), failedAttempts: 0, lockedUntil: null, financialSession: null },
    })
    await audit(request, 'FINANCIAL_PIN_SET')
    const expiresAt = await grantFinancialAccess(request, response)
    response.status(201).json({ message: 'Financial PIN set.', pinEnabled: true, unlocked: true, expiresAt })
  } catch (error) { next(error) }
})

router.post('/verify', pinLimiter, async (request, response, next) => {
  try {
    const parsed = z.object({ pin }).safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_FORMAT', message: PIN_FORMAT })
    const security = await loadSecurity(request.user._id)
    if (!security.pinEnabled) return response.status(409).json({ code: 'PIN_NOT_SET', message: 'No financial PIN has been set yet.' })
    const failure = await checkPin(request, security, parsed.data.pin)
    if (failure) return response.status(failure.status).json(failure.body)
    const expiresAt = await grantFinancialAccess(request, response)
    await audit(request, 'FINANCIAL_UNLOCKED')
    response.json({ unlocked: true, expiresAt })
  } catch (error) { next(error) }
})

router.put('/pin', pinLimiter, async (request, response, next) => {
  try {
    const parsed = z.object({ currentPin: pin, newPin: pin, confirmPin: pin }).safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_FORMAT', message: PIN_FORMAT })
    if (parsed.data.newPin !== parsed.data.confirmPin) return response.status(400).json({ code: 'PIN_MISMATCH', message: 'The two new PINs do not match.' })
    const security = await loadSecurity(request.user._id)
    if (!security.pinEnabled) return response.status(409).json({ code: 'PIN_NOT_SET', message: 'No financial PIN has been set yet.' })
    const failure = await checkPin(request, security, parsed.data.currentPin)
    if (failure) return response.status(failure.status).json(failure.body)
    await UserSecurity.updateOne({ _id: security._id }, { $set: { financialPinHash: await hashPin(parsed.data.newPin), pinUpdatedAt: new Date() } })
    await revokeFinancialAccess(request.user._id, response)
    await audit(request, 'FINANCIAL_PIN_CHANGED')
    response.json({ message: 'Financial PIN changed. Financial information is locked again.', unlocked: false })
  } catch (error) { next(error) }
})

// Recovery for a forgotten PIN: account password + the server-held recovery key
// (FINANCIAL_PIN_RECOVERY_KEY, falling back to SETUP_KEY). Sets the new PIN atomically.
router.post('/pin/reset', pinLimiter, async (request, response, next) => {
  try {
    const parsed = z.object({ password: z.string().min(1), recoveryKey: z.string().min(1), newPin: pin, confirmPin: pin }).safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_FORMAT', message: `Enter your password, the recovery key and a new PIN. ${PIN_FORMAT}` })
    if (parsed.data.newPin !== parsed.data.confirmPin) return response.status(400).json({ code: 'PIN_MISMATCH', message: 'The two new PINs do not match.' })
    const recoveryKey = process.env.FINANCIAL_PIN_RECOVERY_KEY || process.env.SETUP_KEY
    const keyOk = Boolean(recoveryKey) && safeEqual(parsed.data.recoveryKey, recoveryKey)
    const passwordOk = await passwordMatches(request.user._id, parsed.data.password)
    if (!keyOk || !passwordOk) {
      await audit(request, 'FINANCIAL_PIN_RESET_DENIED')
      return response.status(401).json({ code: 'RESET_DENIED', message: 'The password or recovery key is incorrect.' })
    }
    const security = await loadSecurity(request.user._id)
    await UserSecurity.updateOne({ _id: security._id }, {
      $set: { financialPinHash: await hashPin(parsed.data.newPin), pinEnabled: true, pinUpdatedAt: new Date(), failedAttempts: 0, lockedUntil: null, financialSession: null },
    })
    await revokeFinancialAccess(request.user._id, response)
    await audit(request, 'FINANCIAL_PIN_RESET')
    response.json({ message: 'Financial PIN reset. Unlock with the new PIN.', unlocked: false })
  } catch (error) { next(error) }
})

router.post('/lock', async (request, response, next) => {
  try {
    await revokeFinancialAccess(request.user._id, response)
    await audit(request, 'FINANCIAL_LOCKED')
    response.json({ unlocked: false })
  } catch (error) { next(error) }
})

export default router
