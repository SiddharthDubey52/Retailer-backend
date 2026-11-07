import { TacRecord } from '../models/index.js'
import { importOsmocomTacDatabase } from './osmocomTac.js'

// Free, openly licensed TAC (first 8 digits of IMEI) datasets.
export const FREE_TAC_SOURCES = {
  moazeb: {
    url: 'https://raw.githubusercontent.com/MoazEb/tac-database/main/tac_full.csv',
    license: 'MIT',
  },
  vtstech: {
    url: 'https://raw.githubusercontent.com/VTSTech/IMEIDB/master/imeidb.csv',
    license: 'see https://github.com/VTSTech/IMEIDB',
  },
}

function parseCsvLine(line) {
  const out = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { field += '"'; i += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { out.push(field); field = '' }
    else field += char
  }
  out.push(field)
  return out.map((value) => value.trim())
}

const clip = (value, max) => String(value || '').trim().slice(0, max)
const titleCase = (value) => value.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())

// MoazEb format: Brand,TAC,"DEVICE NAME, Maker MODEL-NUMBER, region, year, ..."
export function parseMoazEbCsv(text) {
  const records = []
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line) continue
    const [brand, tac, specs = ''] = parseCsvLine(line)
    if (!/^\d{8}$/.test(tac) || !brand) continue
    const parts = specs.split(',').map((part) => part.trim()).filter(Boolean)
    const deviceName = parts[0] || brand
    let modelNumber = parts[1] || ''
    const maker = modelNumber.split(' ')[0]
    if (maker && (maker.toLowerCase() === brand.toLowerCase() || deviceName.toLowerCase().startsWith(maker.toLowerCase()))) {
      modelNumber = modelNumber.slice(maker.length).trim()
    }
    modelNumber = modelNumber.replace(/(?<=\D)(19|20)\d{2}$/, '').trim()
    if (modelNumber.toLowerCase() === deviceName.toLowerCase()) modelNumber = ''
    records.push({
      tac,
      brandName: clip(titleCase(brand), 100),
      deviceName: clip(titleCase(deviceName), 160),
      modelNumber: clip(modelNumber, 80),
      source: 'moazeb',
    })
  }
  return records
}

// VTSTech format: TAC,Brand,Model,,
export function parseVtsTechCsv(text) {
  const records = []
  for (const line of text.split(/\r?\n/)) {
    const [tac, brand, model] = parseCsvLine(line)
    if (!/^\d{8}$/.test(tac || '') || !brand || !model) continue
    records.push({ tac, brandName: clip(brand, 100), deviceName: clip(`${brand} ${model}`, 160), modelNumber: '', source: 'vtstech' })
  }
  return records
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return response.text()
}

async function upsertRecords(records) {
  const lastUpdated = new Date()
  const seen = new Set()
  let inserted = 0
  for (let offset = 0; offset < records.length; offset += 1000) {
    const batch = records.slice(offset, offset + 1000).filter((r) => !seen.has(r.tac) && seen.add(r.tac))
    if (!batch.length) continue
    const result = await TacRecord.bulkWrite(batch.map((record) => ({
      updateOne: { filter: { tac: record.tac }, update: { $setOnInsert: { ...record, lastUpdated } }, upsert: true },
    })), { ordered: false })
    inserted += result.upsertedCount || 0
  }
  return inserted
}

// Imports every free source. Best (newest) source first; later sources only fill gaps.
// Records saved from HiCellTek or entered by the shop are never overwritten.
export async function importAllFreeTacSources() {
  await TacRecord.deleteMany({ source: { $in: ['osmocom', 'moazeb', 'vtstech'] } })
  const results = {}
  for (const [name, parse] of [['moazeb', parseMoazEbCsv], ['vtstech', parseVtsTechCsv]]) {
    try {
      const records = parse(await download(FREE_TAC_SOURCES[name].url))
      results[name] = { totalInSource: records.length, inserted: await upsertRecords(records) }
    } catch (error) {
      results[name] = { error: error.message }
    }
  }
  try {
    const osmocom = await importOsmocomTacDatabase()
    results.osmocom = { totalInSource: osmocom.totalInSource, inserted: osmocom.inserted }
  } catch (error) {
    results.osmocom = { error: error.message }
  }
  results.totalRecords = await TacRecord.countDocuments({})
  return results
}
