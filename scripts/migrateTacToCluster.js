// Copies the TAC collections from the MAIN cluster to the separate TAC cluster, then verifies them.
//
//   node scripts/migrateTacToCluster.js                 # copy + verify (safe to re-run; nothing is deleted)
//   node scripts/migrateTacToCluster.js --drop-source   # same, then drop TACRecords/TACImportLogs on MAIN
//                                                       # ONLY if verification passed
//
// Source: MAIN_MONGODB_URI (or MONGODB_URI) / MAIN_MONGODB_DB (or MONGODB_DB)
// Target: TAC_MONGODB_URI / TAC_MONGODB_DB  (must be a different cluster)
import 'dotenv/config'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { closeDatabases, connectMainDatabase, connectTacDatabase, mainConfig, tacConfig, tacConnection } from '../config/database.js'
import { TACImportLog, TACRecord } from '../models/tac.js'

const COLLECTIONS = ['TACRecords', 'TACImportLogs']
const BATCH = 2000
const dropSource = process.argv.includes('--drop-source')
const host = (uri) => String(uri).split('@').pop().split('/')[0].split('?')[0]

try {
  if (!tacConfig().dedicated) throw new Error('TAC_MONGODB_URI is not set; there is no separate cluster to copy to.')
  if (host(mainConfig().uri) === host(tacConfig().uri)) throw new Error('MAIN and TAC URIs point at the same cluster.')
  await connectMainDatabase()
  await connectTacDatabase({ required: true })
  const source = mongoose.connection.db
  const target = tacConnection.db
  await Promise.all([TACRecord.createIndexes(), TACImportLog.createIndexes()]) // unique tac index etc. on the target
  const results = {}
  for (const name of COLLECTIONS) {
    const from = source.collection(name)
    const to = target.collection(name)
    const sourceCount = await from.countDocuments()
    let copied = 0
    let batch = []
    const flush = async () => {
      if (!batch.length) return
      // Upsert by _id: re-running never duplicates and picks up records changed since the last run.
      await to.bulkWrite(batch.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })), { ordered: false })
      copied += batch.length
      batch = []
      if (copied % 20000 === 0) console.info(`  ${name}: ${copied}/${sourceCount}`)
    }
    for await (const doc of from.find({}).sort({ _id: 1 })) {
      batch.push(doc)
      if (batch.length >= BATCH) await flush()
    }
    await flush()
    const targetCount = await to.countDocuments()
    // Verify every document id and the TAC key set, not just the counts.
    const digest = async (collection) => {
      const hash = crypto.createHash('sha256')
      for await (const doc of collection.find({}, { projection: { _id: 1, tac: 1, brandName: 1, deviceName: 1, modelNumber: 1 } }).sort({ _id: 1 })) {
        hash.update(`${doc._id}|${doc.tac ?? ''}|${doc.brandName ?? ''}|${doc.deviceName ?? ''}|${doc.modelNumber ?? ''}\n`)
      }
      return hash.digest('hex')
    }
    const [sourceDigest, targetDigest] = await Promise.all([digest(from), digest(to)])
    results[name] = { sourceCount, copied, targetCount, verified: sourceCount === targetCount && sourceDigest === targetDigest }
    console.info(`${name}: source ${sourceCount}, copied ${copied}, target ${targetCount}, contents ${sourceDigest === targetDigest ? 'identical' : 'DIFFERENT'}`)
  }
  const allVerified = Object.values(results).every((r) => r.verified)
  console.info(`\nVerification: ${allVerified ? 'PASSED' : 'FAILED'}`)
  if (dropSource) {
    if (!allVerified) throw new Error('Not dropping the source collections because verification failed.')
    for (const name of COLLECTIONS) await source.collection(name).drop().catch((error) => { if (error.codeName !== 'NamespaceNotFound') throw error })
    console.info(`Dropped ${COLLECTIONS.join(', ')} from the MAIN cluster (${host(mainConfig().uri)}).`)
  } else {
    console.info('Source collections on the MAIN cluster were left untouched. Re-run with --drop-source to free that space.')
  }
  if (!allVerified) process.exitCode = 1
} catch (error) {
  console.error(`Migration failed: ${error.message}`)
  process.exitCode = 1
} finally {
  await closeDatabases()
}
