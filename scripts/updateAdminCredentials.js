import 'dotenv/config'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/database.js'
import { User } from '../models/index.js'

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('Run this command directly in a terminal to enter the password securely.'))
      return
    }

    let value = ''
    process.stdout.write(prompt)
    input.setRawMode(true)
    input.resume()
    const onData = (chunk) => {
      for (const character of chunk.toString()) {
        if (character === '\u0003') {
          input.setRawMode(false)
          input.pause()
          input.off('data', onData)
          reject(new Error('Credential update cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          input.setRawMode(false)
          input.pause()
          input.off('data', onData)
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
        } else {
          value += character
        }
      }
    }
    input.on('data', onData)
  })
}

const username = (process.argv[2] || 'Junaidpersonal').trim().toLowerCase()
if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) throw new Error('Username must be 3-40 letters, numbers, dots, underscores, or hyphens.')

try {
  const password = await readHidden('New admin password (input hidden): ')
  const confirmation = await readHidden('Confirm new admin password: ')
  if (password.length < 10 || password.length > 128) throw new Error('Password must be 10-128 characters.')
  if (password !== confirmation) throw new Error('Passwords do not match.')

  await connectDatabase()
  const passwordHash = await bcrypt.hash(password, 12)
  const user = await User.findOneAndUpdate(
    { role: 'ADMIN' },
    { $set: { username, passwordHash } },
    { new: true, runValidators: true },
  ).select('username')
  if (!user) throw new Error('No administrator account exists yet. Complete first-time setup first.')
  console.info(`Admin login updated for username: ${user.username}`)
} catch (error) {
  console.error(`Admin credential update failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}