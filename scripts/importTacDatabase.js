// Imports licensed public TAC datasets into MongoDB collection "TACRecords".
//
//   node scripts/importTacDatabase.js                       # download all sources and import
//   node scripts/importTacDatabase.js --dry-run             # parse + report only, no writes
//   node scripts/importTacDatabase.js --source=moazeb       # one source only
//   node scripts/importTacDatabase.js --moazeb-file=./tac_full.csv --osmocom-file=./tacdb.sqlite3
//   node scripts/importTacDatabase.js --report=./tac-import-report.json
//
// Safe to repeat: records are upserted, never deleted, and valid values are never blanked.
import 'dotenv/config'
import { writeFile } from 'node:fs/promises'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/database.js'
import { runTacImport } from '../services/tac/importer.js'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=')
  return [key, rest.length ? rest.join('=') : true]
}))

function printReport(report) {
  const line = (label, value) => console.info(`  ${label.padEnd(26)} ${value}`)
  console.info(`\nTAC import report${report.dryRun ? ' (DRY RUN — nothing written)' : ''}`)
  console.info(`Import id: ${report.importId || '-'}   Started: ${report.startedAt.toISOString()}   Finished: ${report.finishedAt?.toISOString()}`)
  for (const s of report.sources) {
    console.info(`\n${s.label} [${s.source}]`)
    line('Source URL', s.location || s.url)
    line('Source version', s.version || '-')
    line('Source updated', s.sourceUpdatedAt ? new Date(s.sourceUpdatedAt).toISOString() : 'unknown')
    line('License', s.license)
    if (s.error) { line('ERROR', s.error); continue }
    line('Records discovered', s.discovered)
    line('Valid unique TACs', s.valid)
    line('Legacy TACs zero-padded', s.zeroPadded)
    line('Failed records', s.failed)
    line('Duplicate rows (same data)', s.duplicates)
    line('Conflicting rows', s.conflicts)
    line('Missing brand', s.missingBrand)
    line('Missing device name', s.missingDevice)
    line('Missing model number', s.missingModel)
    line('Chosen as best record', s.selected)
    line('Imported (new)', s.imported)
    line('Updated', s.updated)
    line('Unchanged', s.unchanged)
  }
  console.info('\nAcross sources')
  line('TACs in more than 1 source', report.crossSource.duplicates)
  line('Brand conflicts resolved', report.crossSource.conflicts)
  console.info('\nTotals')
  for (const [key, value] of Object.entries(report.totals)) line(key, value)
}

try {
  if (!args['dry-run']) await connectDatabase()
  const report = await runTacImport({
    dryRun: Boolean(args['dry-run']),
    sources: typeof args.source === 'string' ? args.source.split(',') : undefined,
    files: { moazeb: args['moazeb-file'], osmocom: args['osmocom-file'] },
    trigger: 'cli',
    onProgress: (message) => console.info(message),
  })
  printReport(report)
  if (typeof args.report === 'string') {
    await writeFile(args.report, JSON.stringify(report, null, 2))
    console.info(`\nFull JSON report written to ${args.report}`)
  }
} catch (error) {
  console.error(`TAC import failed: ${error.message}`)
  process.exitCode = 1
} finally {
  if (mongoose.connection.readyState) await mongoose.disconnect()
}
