import 'dotenv/config'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/database.js'
import { importOsmocomTacDatabase } from '../services/osmocomTac.js'

try {
  await connectDatabase()
  const result = await importOsmocomTacDatabase()
  console.info(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(`TAC import failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}