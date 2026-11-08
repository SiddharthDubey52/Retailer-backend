// Clears the shop's business data for a fresh start. TAC records are never touched.
//
//   npm run fresh:start                     -> preview only, deletes nothing
//   npm run fresh:start -- --execute        -> deletes after you type the confirmation phrase
//   npm run fresh:start -- --execute --include-login
//                                           -> also deletes the login and PIN (owner setup runs again)
//
// Only the collections named below can be cleared. Documents are deleted and the collections are kept,
// so their unique indexes (IMEI, invoice number, ...) stay in place.
import 'dotenv/config'
import { createInterface } from 'node:readline/promises'
import mongoose from 'mongoose'
import { closeDatabases, connectMainDatabase, connectTacDatabase, tacConfig, mainConfig, tacConnection } from '../config/database.js'

const MAIN_BUSINESS = ['inventories', 'sales', 'purchaseinvoices', 'dealers', 'expenses', 'auditlogs', 'devicemodels']
const MAIN_LOGIN = ['users', 'usersecurity']
const TAC_FILES = ['invoiceFiles.files', 'invoiceFiles.chunks'] // uploaded invoice attachments
const PROTECTED = ['TACRecords', 'TACImportLogs']
const PHRASE = 'FRESH START'

const args = new Set(process.argv.slice(2))
const execute = args.has('--execute')
const includeLogin = args.has('--include-login')
const unknown = [...args].filter((arg) => !['--execute', '--include-login'].includes(arg))
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(', ')}`)
  process.exit(1)
}

const mainTargets = includeLogin ? [...MAIN_BUSINESS, ...MAIN_LOGIN] : MAIN_BUSINESS
if ([...mainTargets, ...TAC_FILES].some((name) => PROTECTED.includes(name))) throw new Error('A protected collection is in the delete list.')

const count = (db, name) => db.collection(name).countDocuments()
const countAll = async (db, names) => Object.fromEntries(await Promise.all(names.map(async (name) => [name, await count(db, name)])))
const print = (counts) => Object.entries(counts).forEach(([name, total]) => console.log(`  ${String(total).padStart(9)}  ${name}`))

async function confirmed() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(`\nThis cannot be undone. Type ${PHRASE} to delete: `)).trim() === PHRASE
  } finally {
    rl.close()
  }
}

async function run() {
  await connectMainDatabase()
  await connectTacDatabase({ required: true })
  const mainDb = mongoose.connection.db
  const tacDb = tacConnection.db

  const tacBefore = await countAll(tacDb, PROTECTED)
  const mainBefore = await countAll(mainDb, mainTargets)
  const filesBefore = await countAll(tacDb, TAC_FILES)

  console.log(`\nMAIN database "${mainConfig().dbName}" - will be cleared:`)
  print(mainBefore)
  console.log(`\nTAC database "${tacConfig().dbName}" - invoice files, will be cleared:`)
  print(filesBefore)
  console.log(`\nTAC database "${tacConfig().dbName}" - KEPT, never touched:`)
  print(tacBefore)
  if (!includeLogin) console.log('\nLogin and PIN (users, usersecurity) are KEPT. Add --include-login to clear them too.')

  if (tacBefore.TACRecords === 0) throw new Error('No TAC records found in the TAC database. Stopping: check TAC_MONGODB_URI and TAC_MONGODB_DB.')

  if (!execute) {
    console.log('\nPreview only: nothing was deleted. Add --execute to delete.')
    return
  }
  if (!(await confirmed())) {
    console.log('Cancelled: nothing was deleted.')
    return
  }

  for (const name of mainTargets) await mainDb.collection(name).deleteMany({})
  for (const name of TAC_FILES) await tacDb.collection(name).deleteMany({})

  const left = { ...(await countAll(mainDb, mainTargets)), ...(await countAll(tacDb, TAC_FILES)) }
  const notEmpty = Object.entries(left).filter(([, total]) => total > 0)
  if (notEmpty.length) throw new Error(`Some collections are not empty: ${notEmpty.map(([name]) => name).join(', ')}. Stop the running server and try again.`)
  const tacAfter = await countAll(tacDb, PROTECTED)
  if (PROTECTED.some((name) => tacAfter[name] !== tacBefore[name])) throw new Error('TAC record counts changed during the run. Check the TAC database.')

  console.log(`\nDone. App data cleared. TAC records intact: ${tacAfter.TACRecords.toLocaleString('en-IN')}.`)
  console.log(includeLogin ? 'Open the app to create the owner account again.' : 'You can log in with your existing account and PIN.')
}

try {
  await run()
} catch (error) {
  console.error(`\nStopped: ${error.message}`)
  process.exitCode = 1
} finally {
  await closeDatabases()
}
