// Server-side recovery for a forgotten financial PIN (requires shell access to the server + MONGODB_URI).
//   npm run pin:reset            -> prompts for the admin username and a new 4-digit PIN
// The PIN is read from the terminal, never from arguments, so it does not land in shell history.
import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/database.js'
import { User, UserSecurity } from '../models/index.js'
import { hashPin, PIN_PATTERN } from '../services/financialAccess.js'
import { writeAudit } from '../utils.js'

const rl = createInterface({ input: process.stdin, output: process.stdout })
try {
  await connectDatabase()
  const username = (await rl.question('Admin username: ')).trim().toLowerCase()
  const user = await User.findOne({ $or: [{ username }, { email: username }] }).select('_id role')
  if (!user || user.role !== 'ADMIN') throw new Error('No administrator with that username.')
  const pin = (await rl.question('New 4-digit PIN: ')).trim()
  const confirm = (await rl.question('Confirm PIN: ')).trim()
  if (!PIN_PATTERN.test(pin)) throw new Error('The PIN must be exactly 4 digits.')
  if (pin !== confirm) throw new Error('The PINs do not match.')
  await UserSecurity.updateOne({ user: user._id }, {
    $set: { financialPinHash: await hashPin(pin), pinEnabled: true, pinUpdatedAt: new Date(), failedAttempts: 0, lockedUntil: null, financialSession: null },
  }, { upsert: true })
  await writeAudit(user._id, 'FINANCIAL_PIN_RESET_CLI', 'User', user._id, {})
  console.info('Financial PIN reset. All financial sessions were locked.')
} catch (error) {
  console.error(`PIN reset failed: ${error.message}`)
  process.exitCode = 1
} finally {
  rl.close()
  await mongoose.disconnect()
}
