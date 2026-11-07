import jwt from 'jsonwebtoken'
import { User } from '../models/index.js'

export async function requireAuth(request, response, next) {
  try {
    const header = request.headers.authorization || ''
    const token = request.cookies?.shop_session || (header.startsWith('Bearer ') ? header.slice(7) : null)
    if (!token) return response.status(401).json({ message: 'Please sign in to continue.' })

    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.findById(payload.sub).select('name email role')
    if (!user) return response.status(401).json({ message: 'Your session is no longer valid.' })

    request.user = user
    return next()
  } catch {
    return response.status(401).json({ message: 'Please sign in to continue.' })
  }
}