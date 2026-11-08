// Two independent MongoDB Atlas connections.
//
//   MAIN cluster (mongoose default connection): users, dealers, inventory, sales, purchase invoices,
//     expenses, audit logs, financial PIN settings, device models.
//   TAC cluster (separate connection): TACRecords, TACImportLogs and invoice attachment files (GridFS).
//
// The TAC connection is independent: if it is down, inventory/sales keep working, TAC lookups fall
// back to HiCellTek, and invoice attachments are temporarily unavailable.
import mongoose from 'mongoose'

const POOL = { maxPoolSize: Number(process.env.MONGODB_MAX_POOL) || 10, minPoolSize: 0, serverSelectionTimeoutMS: 10000 }

export const mainConfig = () => ({
  uri: process.env.MAIN_MONGODB_URI || process.env.MONGODB_URI,
  dbName: process.env.MAIN_MONGODB_DB || process.env.MONGODB_DB || 'mobile_shop',
})
export const tacConfig = () => {
  const dedicated = process.env.TAC_MONGODB_URI
  return {
    uri: dedicated || mainConfig().uri,
    // Without a dedicated cluster we keep using the current database so existing TAC data still works.
    dbName: process.env.TAC_MONGODB_DB || (dedicated ? 'mobile_shop_tac' : mainConfig().dbName),
    dedicated: Boolean(dedicated),
  }
}

// Created unopened so models can be registered on it at import time (see models/tac.js).
// bufferCommands:false -> queries fail immediately while the TAC cluster is down instead of hanging.
export const tacConnection = mongoose.createConnection()
tacConnection.set('bufferCommands', false)

let tacRetryTimer = null
let tacState = { status: 'not_started', error: null, dedicated: false }

export async function connectMainDatabase() {
  const { uri, dbName } = mainConfig()
  if (!uri) throw new Error('MAIN_MONGODB_URI (or MONGODB_URI) is required to start the API')
  mongoose.set('strictQuery', true)
  await mongoose.connect(uri, { dbName, ...POOL })
  console.info(`Main MongoDB connected: ${mongoose.connection.host}/${dbName}`)
  return mongoose.connection
}

/**
 * Opens the TAC connection. With { required: false } (the API server) a failure is logged and retried
 * in the background with backoff instead of stopping the app.
 */
export async function connectTacDatabase({ required = false, attempt = 1 } = {}) {
  const { uri, dbName, dedicated } = tacConfig()
  tacState = { status: 'connecting', error: null, dedicated }
  if (!dedicated) console.warn('TAC_MONGODB_URI is not set: TAC data uses the MAIN cluster. Set it to use the separate TAC cluster.')
  try {
    await tacConnection.openUri(uri, { dbName, ...POOL, maxPoolSize: 5 })
    tacState = { status: 'connected', error: null, dedicated }
    console.info(`TAC MongoDB connected: ${tacConnection.host}/${dbName}${dedicated ? ' (separate cluster)' : ' (main cluster fallback)'}`)
    return tacConnection
  } catch (error) {
    tacState = { status: 'unavailable', error: error.message, dedicated }
    if (required) throw error
    const delay = Math.min(60000, 2000 * 2 ** Math.min(attempt, 5))
    console.error(`TAC MongoDB unavailable (${error.message}). Retrying in ${Math.round(delay / 1000)}s; inventory and sales are unaffected.`)
    clearTimeout(tacRetryTimer)
    tacRetryTimer = setTimeout(() => connectTacDatabase({ required: false, attempt: attempt + 1 }).catch(() => {}), delay)
    tacRetryTimer.unref?.()
    return null
  }
}

tacConnection.on('disconnected', () => { if (tacState.status === 'connected') tacState = { ...tacState, status: 'disconnected' } })
tacConnection.on('reconnected', () => { tacState = { ...tacState, status: 'connected', error: null } })

export const isTacConnected = () => tacConnection.readyState === 1
export const isMainConnected = () => mongoose.connection.readyState === 1

export function databaseHealth() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting']
  return {
    main: states[mongoose.connection.readyState] || 'unknown',
    tac: isTacConnected() ? 'connected' : tacState.status,
    tacCluster: tacState.dedicated ? 'separate' : 'main_fallback',
  }
}

export async function closeDatabases() {
  clearTimeout(tacRetryTimer)
  await Promise.allSettled([tacConnection.close(), mongoose.disconnect()])
}

// Backwards compatible name used by existing scripts (connects MAIN only).
export const connectDatabase = connectMainDatabase
