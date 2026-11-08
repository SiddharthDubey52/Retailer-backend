// TAC import engine: download -> parse -> validate -> dedupe -> resolve conflicts -> upsert -> report.
// Safe to run repeatedly. It never deletes records and never replaces a value with an empty one.
import { TACImportLog, TACRecord } from '../../models/index.js'
import { compareKey } from './normalize.js'
import { TAC_SOURCES } from './sources.js'

const FIELDS = ['brandName', 'deviceName', 'modelNumber']
const BATCH_SIZE = 2000
const STALE_LOCK_MS = 2 * 60 * 60 * 1000
const SAMPLE_LIMIT = 15

const completeness = (r) => FIELDS.reduce((n, f) => n + (r[f] ? 1 : 0), 0)
const brandsAgree = (a, b) => {
  const [x, y] = [compareKey(a), compareKey(b)]
  return !x || !y || x.includes(y) || y.includes(x)
}
const sameValues = (a, b) => FIELDS.every((f) => (a[f] || '') === (b[f] || ''))
const better = (a, b) => completeness(a) - completeness(b) || a.priority - b.priority

function newSourceStats(source, fetched) {
  return {
    source: source.name,
    label: source.label,
    url: source.url,
    license: source.license,
    location: fetched?.location || '',
    version: fetched?.version || '',
    sourceUpdatedAt: fetched?.sourceUpdatedAt || null,
    discovered: 0, valid: 0, failed: 0, failedSamples: [], zeroPadded: 0,
    duplicates: 0, conflicts: 0, conflictSamples: [],
    missingBrand: 0, missingDevice: 0, missingModel: 0,
    selected: 0, imported: 0, updated: 0, unchanged: 0,
  }
}

/** Collapses repeated TACs inside one source. Exported for tests. */
export function dedupeWithinSource(records, stats, meta) {
  const byTac = new Map()
  for (const record of records) {
    const candidate = { ...record, source: meta.name, priority: meta.priority, sourceVersion: meta.version, sourceUpdatedAt: meta.sourceUpdatedAt }
    const current = byTac.get(record.tac)
    if (!current) { byTac.set(record.tac, candidate); continue }
    if (sameValues(current, candidate)) { stats.duplicates += 1; continue }
    stats.conflicts += 1
    if (stats.conflictSamples.length < SAMPLE_LIMIT) stats.conflictSamples.push({ tac: record.tac, kept: pick(current, candidate), values: [strip(current), strip(candidate)] })
    if (better(candidate, current) > 0) byTac.set(record.tac, candidate)
  }
  stats.valid = byTac.size
  for (const r of byTac.values()) {
    if (!r.brandName) stats.missingBrand += 1
    if (!r.deviceName) stats.missingDevice += 1
    if (!r.modelNumber) stats.missingModel += 1
  }
  return byTac
}
const strip = (r) => ({ brandName: r.brandName, deviceName: r.deviceName, modelNumber: r.modelNumber })
const pick = (a, b) => strip(better(b, a) > 0 ? b : a)

/** Merges per-source maps into one record per TAC. Exported for tests. */
export function mergeSources(sourceMaps, crossStats) {
  const merged = new Map()
  for (const map of sourceMaps) {
    for (const [tac, candidate] of map) {
      const current = merged.get(tac)
      if (!current) { merged.set(tac, { ...candidate, sources: [{ source: candidate.source, sourceVersion: candidate.sourceVersion }] }); continue }
      crossStats.duplicates += 1
      const agree = brandsAgree(current.brandName, candidate.brandName)
      if (!agree) {
        crossStats.conflicts += 1
        if (crossStats.conflictSamples.length < SAMPLE_LIMIT) crossStats.conflictSamples.push({ tac, values: [{ source: current.source, ...strip(current) }, { source: candidate.source, ...strip(candidate) }] })
      }
      const [winner, other] = better(candidate, current) > 0 ? [candidate, current] : [current, candidate]
      const next = { ...winner, sources: [...current.sources, { source: candidate.source, sourceVersion: candidate.sourceVersion }] }
      // Fill gaps from the other source only when both describe the same brand.
      if (agree) for (const field of FIELDS) if (!next[field] && other[field]) next[field] = other[field]
      next.releaseYear ??= other.releaseYear ?? null
      next.sourceRecordDate ??= other.sourceRecordDate ?? null
      merged.set(tac, next)
    }
  }
  return merged
}

/**
 * Combines an incoming record with what is already stored. Exported for tests.
 * - never overwrites a value with an empty one
 * - a lower-priority source may only fill empty fields, and only for the same brand
 */
export function mergeWithExisting(existing, incoming, priorityOf) {
  if (!existing) return { doc: incoming, changed: true, inserted: true }
  const existingPriority = priorityOf(existing.source)
  const canOverride = incoming.priority >= existingPriority
  const agree = brandsAgree(existing.brandName, incoming.brandName)
  const doc = { ...existing }
  let tookFromIncoming = false
  for (const field of FIELDS) {
    const value = incoming[field]
    if (!value || value === existing[field]) continue
    if (!existing[field] ? (canOverride || agree) : canOverride) { doc[field] = value; tookFromIncoming = true }
  }
  if (canOverride && tookFromIncoming) {
    Object.assign(doc, { source: incoming.source, sourceVersion: incoming.sourceVersion, sourceUpdatedAt: incoming.sourceUpdatedAt })
  }
  doc.releaseYear = existing.releaseYear ?? incoming.releaseYear ?? null
  doc.sourceRecordDate = existing.sourceRecordDate ?? incoming.sourceRecordDate ?? null
  const refs = new Map((existing.sources || []).map((ref) => [ref.source, ref]))
  for (const ref of incoming.sources || []) refs.set(ref.source, ref)
  doc.sources = [...refs.values()]
  const changed = !sameValues(existing, doc) || existing.source !== doc.source
    || JSON.stringify(existing.sources || []) !== JSON.stringify(doc.sources)
    || existing.releaseYear !== doc.releaseYear || String(existing.sourceRecordDate) !== String(doc.sourceRecordDate)
  return { doc, changed, inserted: false }
}

async function acquireLock({ trigger, userId, logModel }) {
  const create = () => logModel.create({ status: 'running', trigger, startedBy: userId || null, startedAt: new Date() })
  try { return await create() } catch (error) {
    if (error.code !== 11000) throw error
    const stale = await logModel.findOneAndUpdate(
      { status: 'running', startedAt: { $lt: new Date(Date.now() - STALE_LOCK_MS) } },
      { status: 'failed', finishedAt: new Date(), error: 'Marked failed: import did not finish within 2 hours.' },
    )
    if (stale) return create()
    const busy = new Error('A TAC import is already running. Check the import history for progress.')
    busy.status = 409
    throw busy
  }
}

/**
 * Runs a full import. Options:
 *   sources: subset of source names (default all), files: { moazeb: path, osmocom: path }
 *   dryRun: parse and report without writing, trigger: 'cli' | 'api', userId
 */
export async function runTacImport({
  sources: names, files = {}, dryRun = false, trigger = 'cli', userId = null,
  recordModel = TACRecord, logModel = TACImportLog, sourceList = TAC_SOURCES, onProgress = () => {}, onStart = () => {},
} = {}) {
  const selected = sourceList.filter((s) => !names?.length || names.includes(s.name))
  if (!selected.length) throw Object.assign(new Error('No matching TAC source selected.'), { status: 400 })
  const priorityOf = (name) => sourceList.find((s) => s.name === name)?.priority ?? 0
  const startedAt = new Date()
  const log = dryRun ? null : await acquireLock({ trigger, userId, logModel })
  onStart(log?._id || null)
  const report = { importId: log?._id || null, dryRun, startedAt, finishedAt: null, sources: [], crossSource: { duplicates: 0, conflicts: 0, conflictSamples: [] }, totals: {} }

  try {
    const maps = []
    for (const source of selected) {
      onProgress(`Downloading ${source.label}…`)
      let fetched
      try { fetched = await source.fetch({ file: files[source.name] }) } catch (error) {
        report.sources.push({ ...newSourceStats(source), error: `Download failed: ${error.message}` })
        continue
      }
      const stats = newSourceStats(source, fetched)
      onProgress(`Parsing ${source.label} (${fetched.version})…`)
      try {
        const records = await source.parse(fetched.buffer, stats, fetched)
        if (stats.newestSourceRecordDate && !stats.sourceUpdatedAt) stats.sourceUpdatedAt = stats.newestSourceRecordDate
        maps.push(dedupeWithinSource(records, stats, { name: source.name, priority: source.priority, version: stats.version, sourceUpdatedAt: stats.sourceUpdatedAt }))
      } catch (error) {
        stats.error = `Parse failed: ${error.message}`
      }
      report.sources.push(stats)
    }
    if (!maps.length) throw new Error('No TAC source could be downloaded and parsed.')

    const merged = mergeSources(maps, report.crossSource)
    const bySource = Object.fromEntries(report.sources.map((s) => [s.source, s]))
    for (const record of merged.values()) bySource[record.source].selected += 1
    const totals = { uniqueTacs: merged.size, imported: 0, updated: 0, unchanged: 0, complete: 0, missingBrand: 0, missingDevice: 0, missingModel: 0, writeErrors: 0 }
    for (const r of merged.values()) {
      if (completeness(r) === 3) totals.complete += 1
      if (!r.brandName) totals.missingBrand += 1
      if (!r.deviceName) totals.missingDevice += 1
      if (!r.modelNumber) totals.missingModel += 1
    }

    if (!dryRun) {
      await recordModel.createIndexes()
      const all = [...merged.values()]
      for (let offset = 0; offset < all.length; offset += BATCH_SIZE) {
        const batch = all.slice(offset, offset + BATCH_SIZE)
        const existing = new Map((await recordModel.find({ tac: { $in: batch.map((r) => r.tac) } }).lean()).map((d) => [d.tac, d]))
        const ops = []
        for (const incoming of batch) {
          const { doc, changed, inserted } = mergeWithExisting(existing.get(incoming.tac), incoming, priorityOf)
          const stats = bySource[incoming.source]
          if (!changed) { totals.unchanged += 1; stats.unchanged += 1; continue }
          const fields = {
            brandName: doc.brandName || '', deviceName: doc.deviceName || '', modelNumber: doc.modelNumber || '',
            source: doc.source, sourceVersion: doc.sourceVersion || '', sourceUpdatedAt: doc.sourceUpdatedAt || null,
            sourceRecordDate: doc.sourceRecordDate || null, releaseYear: doc.releaseYear ?? null, sources: doc.sources, lastImportId: log._id,
          }
          if (inserted) {
            totals.imported += 1; stats.imported += 1
            ops.push({ updateOne: { filter: { tac: incoming.tac }, update: { $setOnInsert: { tac: incoming.tac, importedAt: startedAt, allocationDate: null, ...fields } }, upsert: true } })
          } else {
            totals.updated += 1; stats.updated += 1
            ops.push({ updateOne: { filter: { tac: incoming.tac }, update: { $set: fields } } })
          }
        }
        if (ops.length) {
          try { await recordModel.bulkWrite(ops, { ordered: false }) } catch (error) {
            totals.writeErrors += error.writeErrors?.length || 1
            if (!error.writeErrors) throw error
          }
        }
        onProgress(`Wrote ${Math.min(offset + BATCH_SIZE, all.length)} / ${all.length} TACs`)
      }
      totals.collectionCount = await recordModel.estimatedDocumentCount()
    }
    report.totals = totals
    report.finishedAt = new Date()
    if (log) await logModel.updateOne({ _id: log._id }, { status: 'completed', finishedAt: report.finishedAt, sources: report.sources, totals: { ...totals, crossSource: report.crossSource } })
    return report
  } catch (error) {
    if (log) await logModel.updateOne({ _id: log._id }, { status: 'failed', finishedAt: new Date(), sources: report.sources, error: error.message })
    throw error
  }
}
