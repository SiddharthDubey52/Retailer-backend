import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { connectDatabase } from './config/database.js'
import { requireAuth } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import inventoryRoutes from './routes/inventory.js'
import salesRoutes from './routes/sales.js'
import dealerRoutes from './routes/dealers.js'
import dashboardRoutes from './routes/dashboard.js'
import reportRoutes from './routes/reports.js'
import deviceLookupRoutes from './routes/deviceLookup.js'

const app = express()
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim())

app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: allowedOrigins, credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }), authRoutes)
app.get('/api/health', (_request, response) => response.json({ status: 'ok' }))
app.use('/api', requireAuth)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/inventory', inventoryRoutes)
app.use('/api/sales', salesRoutes)
app.use('/api/dealers', dealerRoutes)
app.use('/api/reports', reportRoutes)
app.use('/api/device-lookup', deviceLookupRoutes)
app.use((error, _request, response, _next) => {
  void _next
  if (error.code === 11000) return response.status(409).json({ message: 'That IMEI or email is already in use.' })
  if (error.name === 'CastError') return response.status(400).json({ message: 'The requested record is invalid.' })
  if (error.name === 'ValidationError') return response.status(400).json({ message: 'Check the submitted information.', details: error.message })
  console.error(error)
  response.status(error.status || 500).json({ message: error.status ? error.message : 'Something went wrong. Please try again.' })
})

const port = Number(process.env.PORT) || 5000
try {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required to start the API')
  await connectDatabase()
  app.listen(port, () => console.info(`API listening on port ${port}`))
} catch (error) {
  console.error(`API startup failed: ${error.message}`)
  process.exitCode = 1
}