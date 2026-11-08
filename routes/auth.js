import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { User } from '../models/index.js'
import { requireAuth } from '../middleware/auth.js'
import { revokeFinancialAccess } from '../services/financialAccess.js'

const router = Router()
const passwordSchema = z.string().min(10).max(128)
const setupSchema = z.object({
  name: z.string().trim().min(2).max(100),
  username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.union([z.string().email().max(254), z.literal('')]).optional(),
  password: passwordSchema,
  setupKey: z.string().min(1),
})
const loginSchema = z.object({ identifier: z.string().trim().min(1).max(254), password: passwordSchema })

function setSession(response, user) {
  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '12h' })
  response.cookie('shop_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  })
  return token
}

router.get('/status', async (_request, response, next) => {
  try {
    response.json({ setupRequired: (await User.countDocuments()) === 0 })
  } catch (error) { next(error) }
})

router.post('/setup', async (request, response, next) => {
  try {
    if (await User.exists({})) return response.status(409).json({ message: 'Initial setup has already been completed.' })
    const parsed = setupSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Enter a name, username, password of at least 10 characters, and setup key. Email is optional.' })
    if (!process.env.SETUP_KEY || parsed.data.setupKey !== process.env.SETUP_KEY) {
      return response.status(403).json({ message: 'The setup key is invalid.' })
    }
    const user = await User.create({
      name: parsed.data.name,
      username: parsed.data.username.toLowerCase(),
      passwordHash: await bcrypt.hash(parsed.data.password, 12),
      ...(parsed.data.email && { email: parsed.data.email.toLowerCase() }),
    })
    const token = setSession(response, user)
    response.status(201).json({ token, user: { id: user.id, name: user.name, username: user.username, email: user.email } })
  } catch (error) { next(error) }
})

router.post('/login', async (request, response, next) => {
  try {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Enter a username or email and password.' })
    const identifier = parsed.data.identifier.toLowerCase()
    const user = await User.findOne({ $or: [{ email: identifier }, { username: identifier }] }).select('+passwordHash')
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return response.status(401).json({ message: 'Username or password is incorrect.' })
    }
    const token = setSession(response, user)
    response.json({ token, user: { id: user.id, name: user.name, username: user.username, email: user.email } })
  } catch (error) { next(error) }
})

router.post('/logout', async (request, response) => {
  // Logging out also locks financial information.
  const header = request.headers.authorization || ''
  const token = request.cookies?.shop_session || (header.startsWith('Bearer ') ? header.slice(7) : null)
  let userId
  try { userId = token ? jwt.verify(token, process.env.JWT_SECRET).sub : null } catch { userId = null }
  await revokeFinancialAccess(userId, response).catch(() => {})
  response.clearCookie('shop_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', path: '/' })
  response.status(204).end()
})

router.get('/me', requireAuth, (request, response) => {
  response.json({ user: { id: request.user.id, name: request.user.name, username: request.user.username, email: request.user.email } })
})

export default router