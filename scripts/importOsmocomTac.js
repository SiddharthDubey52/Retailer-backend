import 'dotenv/config'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/database.js'
import { importAllFreeTacSources } from '../services/freeTacSources.js'

try {
  await connectDatabase()
  const result = await importAllFreeTacSources()
  console.info(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(`TAC import failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}