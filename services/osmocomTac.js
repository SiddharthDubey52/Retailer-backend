import { TacRecord } from '../models/index.js'

export const OSMOCOM_TAC_EXPORT_URL = 'http://tacdb.osmocom.org/export/tacdb.json'
export const OSMOCOM_TAC_LICENSE = 'CC-BY-SA-3.0'

export function flattenOsmocomTacExport(dataset, lastUpdated = new Date()) {
  if (!dataset?.brands || typeof dataset.brands !== 'object') {
    throw new Error('Osmocom TAC export has an unsupported format.')
  }

  const records = new Map()
  for (const [brandName, brand] of Object.entries(dataset.brands)) {
    for (const modelEntry of brand.models || []) {
      for (const [deviceName, details] of Object.entries(modelEntry)) {
        for (const rawTac of details.tacs || []) {
          const tac = String(rawTac).trim()
          if (!/^\d{8}$/.test(tac) || records.has(tac)) continue
          records.set(tac, {
            tac,
            brandName: brandName.trim(),
            deviceName: deviceName.trim(),
            modelNumber: '',
            source: 'osmocom',
            lastUpdated,
          })
        }
      }
    }
  }
  return [...records.values()]
}

export async function importOsmocomTacDatabase() {
  const response = await fetch(OSMOCOM_TAC_EXPORT_URL, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) throw new Error(`Osmocom TAC export returned HTTP ${response.status}.`)

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > 20 * 1024 * 1024) throw new Error('Osmocom TAC export exceeds the 20 MB import limit.')
  const text = await response.text()
  if (Buffer.byteLength(text) > 20 * 1024 * 1024) throw new Error('Osmocom TAC export exceeds the 20 MB import limit.')

  let dataset
  try { dataset = JSON.parse(text) }
  catch { throw new Error('Osmocom TAC export is not valid JSON.') }
  const importedAt = new Date()
  const records = flattenOsmocomTacExport(dataset, importedAt)
  if (!records.length) throw new Error('Osmocom TAC export did not contain usable records.')

  let inserted = 0
  for (let offset = 0; offset < records.length; offset += 1000) {
    const batch = records.slice(offset, offset + 1000)
    const result = await TacRecord.bulkWrite(batch.map((record) => ({
      updateOne: {
        filter: { tac: record.tac },
        update: { $setOnInsert: record },
        upsert: true,
      },
    })), { ordered: false })
    inserted += result.upsertedCount || 0
  }

  return {
    source: 'osmocom',
    license: OSMOCOM_TAC_LICENSE,
    totalInSource: records.length,
    inserted,
    existing: records.length - inserted,
    importedAt,
  }
}