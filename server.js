import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { closeDatabases, connectMainDatabase, connectTacDatabase, databaseHealth } from './config/database.js'
import { requireAuth } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import inventoryRoutes from './routes/inventory.js'
import salesRoutes from './routes/sales.js'
import dealerRoutes from './routes/dealers.js'
import dashboardRoutes from './routes/dashboard.js'
import reportRoutes from './routes/reports.js'
import deviceLookupRoutes from './routes/deviceLookup.js'
import financialRoutes from './routes/financial.js'
import purchaseInvoiceRoutes from './routes/purchaseInvoices.js'
import { Inventory } from './models/index.js'
import { requireFinancialAccess } from './services/financialAccess.js'

const app = express()
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean)

app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: allowedOrigins, credentials: true }))
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }), authRoutes)
app.get('/api/health', (_request, response) => {
  const databases = databaseHealth()
  response.status(databases.main === 'connected' ? 200 : 503).json({ status: databases.main === 'connected' ? 'ok' : 'degraded', databases })
})
app.use('/api', requireAuth)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/inventory', inventoryRoutes)
app.use('/api/sales', salesRoutes)
app.use('/api/dealers', dealerRoutes)
app.use('/api/reports', requireFinancialAccess, reportRoutes) // profit reports and CSV export are entirely financial
app.use('/api/financial', financialRoutes)
app.use('/api/purchase-invoices', purchaseInvoiceRoutes)
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
  await connectMainDatabase()
  // Make sure the unique IMEI index really exists before accepting requests.
  await Inventory.init().catch((error) => console.error(`IMEI unique index could not be built: ${error.message}`))
  // The TAC cluster connects independently; if it is down the API still starts and retries in the background.
  connectTacDatabase({ required: false }).catch(() => {})
  // One-time, idempotent backfill for quick stock-out search on records created before imeiLastSix existed.
  const backfill = await Inventory.updateMany(
    { imeiLastSix: { $exists: false } },
    [{ $set: { imeiLastSix: { $setUnion: [{ $map: { input: '$imeiKeys', as: 'key', in: { $substrCP: ['$$key', { $subtract: [{ $strLenCP: '$$key' }, 6] }, 6] } } }] } } }],
    { updatePipeline: true },
  )
  if (backfill.modifiedCount) console.info(`Backfilled IMEI last-six digits for ${backfill.modifiedCount} inventory records.`)
  const server = app.listen(port, () => console.info(`API listening on port ${port}`))
  const shutdown = (signal) => {
    console.info(`${signal} received: closing HTTP server and database connections.`)
    server.close(() => closeDatabases().finally(() => process.exit(0)))
    setTimeout(() => process.exit(1), 10000).unref()
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
} catch (error) {
  console.error(`API startup failed: ${error.message}`)
  process.exitCode = 1
}