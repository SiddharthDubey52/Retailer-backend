// Financial PIN protection. The server alone decides whether cost/profit data may be returned.
//
// - PIN: 4 digits, stored only as bcrypt(HMAC-SHA256(pepper, pin)); the pepper never touches the DB.
// - Unlock: a 5-minute signed token in an HttpOnly cookie, bound to the user and to the login token,
//   and checked against a server-side session id so Lock / logout / PIN change revoke it at once.
// - Protection is enforced once the owner has set a PIN (pinEnabled). Before that nothing changes.
import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { UserSecurity } from '../models/index.js'

export const FINANCIAL_COOKIE = 'shop_financial'
export const PIN_PATTERN = /^\d{4}$/
export const MAX_FAILED_ATTEMPTS = Number(process.env.FINANCIAL_PIN_MAX_ATTEMPTS) || 5
export const LOCKOUT_MS = (Number(process.env.FINANCIAL_PIN_LOCKOUT_MINUTES) || 15) * 60 * 1000
export const unlockMs = () => (Number(process.env.FINANCIAL_UNLOCK_MINUTES) || 5) * 60 * 1000

const derive = (label) => crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(label).digest('hex')
const pepper = () => process.env.FINANCIAL_PIN_PEPPER || derive('financial-pin-pepper')
const tokenSecret = () => process.env.FINANCIAL_TOKEN_SECRET || derive('financial-access-token')
const peppered = (pin) => crypto.createHmac('sha256', pepper()).update(pin).digest('hex')
export const sessionBinding = (authToken) => crypto.createHash('sha256').update(String(authToken || '')).digest('hex').slice(0, 32)

export const hashPin = (pin) => bcrypt.hash(peppered(pin), 12)
export const pinMatches = (pin, hash) => Boolean(hash) && bcrypt.compare(peppered(pin), hash)

export function cookieOptions(maxAge) {
  const production = process.env.NODE_ENV === 'production'
  return { httpOnly: true, secure: production, sameSite: production ? 'none' : 'lax', path: '/', ...(maxAge && { maxAge }) }
}

export function safeEqual(a, b) {
  const [x, y] = [Buffer.from(String(a ?? '')), Buffer.from(String(b ?? ''))]
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y)
}

/** Starts a financial session for the user and sets the HttpOnly cookie. */
export async function grantFinancialAccess(request, response) {
  const jti = crypto.randomBytes(16).toString('hex')
  const ttl = unlockMs()
  const expiresAt = new Date(Date.now() + ttl)
  const binding = sessionBinding(request.authToken)
  await UserSecurity.updateOne({ user: request.user._id }, { $set: { financialSession: { jti, binding, expiresAt } } })
  const token = jwt.sign({ sub: String(request.user._id), jti, bind: binding }, tokenSecret(), { expiresIn: Math.floor(ttl / 1000), audience: 'financial-access' })
  response.cookie(FINANCIAL_COOKIE, token, cookieOptions(ttl))
  return expiresAt
}

export async function revokeFinancialAccess(userId, response) {
  if (userId) await UserSecurity.updateOne({ user: userId }, { $set: { financialSession: null } })
  response?.clearCookie(FINANCIAL_COOKIE, cookieOptions())
}

/**
 * Resolves (and caches on the request) whether this request may see financial data.
 * Returns { granted, configured, expiresAt?, reason? }.
 */
export async function financialAccess(request) {
  if (request.financialAccess) return request.financialAccess
  const security = await UserSecurity.findOne({ user: request.user._id }).select('pinEnabled +financialSession').lean()
  let result
  if (!security?.pinEnabled) result = { granted: true, configured: false }
  else {
    const token = request.cookies?.[FINANCIAL_COOKIE]
    const session = security.financialSession
    let payload
    try { payload = token ? jwt.verify(token, tokenSecret(), { audience: 'financial-access' }) : null } catch { payload = null }
    const valid = payload && session
      && payload.sub === String(request.user._id)
      && safeEqual(payload.jti, session.jti)
      && safeEqual(payload.bind, session.binding)
      && safeEqual(session.binding, sessionBinding(request.authToken))
      && new Date(session.expiresAt) > new Date()
    result = valid
      ? { granted: true, configured: true, expiresAt: session.expiresAt }
      : { granted: false, configured: true, reason: token ? 'expired_or_invalid' : 'missing' }
  }
  request.financialAccess = result
  return result
}

export const LOCKED_RESPONSE = { code: 'FINANCIAL_PIN_REQUIRED', message: 'Financial information is protected. Enter your 4-digit security PIN to continue.' }

export async function requireFinancialAccess(request, response, next) {
  try {
    if ((await financialAccess(request)).granted) return next()
    return response.status(403).json(LOCKED_RESPONSE)
  } catch (error) { return next(error) }
}

// ---- Redaction helpers: remove cost and profit values when access is not granted ----
const plain = (doc) => (typeof doc?.toObject === 'function' ? doc.toObject() : { ...doc })

export function redactInventory(item, granted) {
  const data = plain(item)
  if (!granted) data.purchasePrice = null
  return data
}

export function redactSale(sale, granted) {
  const data = plain(sale)
  if (granted) return data
  data.purchasePrice = null
  data.grossProfit = null
  data.netProfit = null
  if (data.snapshot) data.snapshot = { ...data.snapshot, purchasePrice: null }
  return data
}
