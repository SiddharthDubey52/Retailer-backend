// Licensed public TAC sources. Each source exposes: metadata, fetch() and parse().
// Sources reviewed but NOT imported (see backend/README.md "TAC sources"):
//   - FCCID.io /TAC/data: protected by a bot "Security check" (HTTP 403) and no reuse license found.
//   - Optus (isthisphoneblocked.net.au): no redistribution license published; its V36 list is
//     already incorporated upstream by MoazEb, which publishes under MIT.
import crypto from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clean, compareKey, normalizeBrand, normalizeDevice, normalizeModelNumber, normalizeTac, parseCsv, stripBrandPrefix,
} from './normalize.js'

const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024
const CURRENT_YEAR = new Date().getUTCFullYear()
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

async function download(url, { accept = '*/*', timeoutMs = 180000 } = {}) {
  const response = await fetch(url, { headers: { Accept: accept, 'User-Agent': 'mobile-shop-tac-import' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`${url} exceeds the download limit.`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error(`${url} exceeds the download limit.`)
  return { buffer, lastModified: response.headers.get('last-modified') }
}

const yearValue = (text) => {
  const year = Number(text)
  return year >= 1990 && year <= CURRENT_YEAR + 1 ? year : null
}
const looksLikeCode = (token) => /\d/.test(token) && !/^\d?G$/i.test(token) && !yearValue(token)

/**
 * Extracts a model number from MoazEb's "Maker MODEL[YEAR]" segment, e.g.
 * "Samsung SM-J111F DS2015" -> { model: "SM-J111F DS", year: 2015 }.
 * Returns '' when the segment is only a marketing name or cannot be separated reliably.
 */
export function extractMoazEbModel(segment, deviceName) {
  let text = clean(segment)
  let year = null
  const glued = text.match(/^(.*\S)(\d{4})$/)
  // MoazEb appends the release year directly to the model code ("SM-A166U2024").
  if (glued && yearValue(glued[2])) {
    year = yearValue(glued[2])
    text = glued[1].trim()
  }
  const tokens = text.split(' ')
  let start = tokens.findIndex((token) => /\d/.test(token))
  if (start === -1) return { model: '', year }
  if (start > 0 && tokens[start - 1] === 'vivo') start -= 1
  const candidate = normalizeModelNumber(tokens.slice(start).join(' '))
  const key = compareKey(candidate)
  const valid = candidate && tokens.length - start <= 3 && candidate.length <= 40 && key
    && !compareKey(deviceName).includes(key) && looksLikeCode(tokens.at(-1) || candidate)
  return { model: valid ? candidate : '', year }
}

/** Accepts a standalone model code such as "A1920" from "A1920 - (US Model)". */
function extractStandaloneCode(segment) {
  const token = clean(segment).split(/\s+-\s+|\s+\(/)[0]
  return /^[A-Z0-9][A-Z0-9/-]{2,19}$/.test(token) && looksLikeCode(token) ? token : ''
}

/** Parses one MoazEb row. Exported for tests. */
export function parseMoazEbRow(brandRaw, specs) {
  const parts = String(specs || '').split(',').map((part) => clean(part)).filter(Boolean)
  const brandName = normalizeBrand(brandRaw)
  let deviceRaw = ''
  let modelNumber = ''
  let releaseYear = null
  for (const part of parts.slice(1)) releaseYear ??= /^\d{4}$/.test(part) ? yearValue(part) : null

  if (parts.length >= 2 && compareKey(parts[0]) === compareKey(brandRaw)) {
    // "BRAND, BRAND NAME-OR-CODE": the source does not separate a model number here.
    deviceRaw = stripBrandPrefix(parts[1], brandRaw)
  } else if (parts.length) {
    deviceRaw = stripBrandPrefix(parts[0], brandRaw)
    if (parts[1]) {
      const extracted = extractMoazEbModel(parts[1], deviceRaw)
      modelNumber = extracted.model
      releaseYear ??= extracted.year
    }
    if (!modelNumber && parts[2]) modelNumber = extractStandaloneCode(parts[2])
  }
  return { brandName, deviceName: normalizeDevice(deviceRaw), modelNumber, releaseYear }
}

export const moazEbSource = {
  name: 'moazeb',
  label: 'MoazEb TAC Database',
  url: 'https://github.com/MoazEb/tac-database',
  license: 'MIT (repository LICENSE, (c) 2026 Moaz Ebrahem). Upstream notes it aggregates Osmocom (CC-BY-SA-3.0) and the Optus V36 public TAC list.',
  priority: 2,
  async fetch({ file } = {}) {
    if (file) {
      const buffer = await readFile(file)
      return { buffer, version: `file:sha256:${sha256(buffer).slice(0, 12)}`, sourceUpdatedAt: null, location: file }
    }
    let ref = 'main'
    let sourceUpdatedAt = null
    try {
      const response = await fetch('https://api.github.com/repos/MoazEb/tac-database/commits?path=tac_full.csv&per_page=1', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mobile-shop-tac-import' }, signal: AbortSignal.timeout(20000),
      })
      const [commit] = response.ok ? await response.json() : []
      if (commit?.sha) { ref = commit.sha; sourceUpdatedAt = new Date(commit.commit.committer.date) }
    } catch { /* fall back to main; version will be the content hash */ }
    const location = `https://raw.githubusercontent.com/MoazEb/tac-database/${ref}/tac_full.csv`
    const { buffer } = await download(location, { accept: 'text/csv' })
    const version = ref === 'main' ? `main@sha256:${sha256(buffer).slice(0, 12)}` : `commit:${ref.slice(0, 12)}`
    return { buffer, version, sourceUpdatedAt, location }
  },
  async parse(buffer, stats) {
    const rows = parseCsv(buffer.toString('utf8'))
    const header = rows.shift()?.map((h) => h.trim().toLowerCase()) || []
    const [iBrand, iTac, iSpecs] = ['brand', 'tac', 'specs'].map((name) => header.indexOf(name))
    if (iBrand < 0 || iTac < 0 || iSpecs < 0) throw new Error('MoazEb CSV header changed; expected Brand,TAC,SPECS.')
    const records = []
    for (const row of rows) {
      stats.discovered += 1
      const tac = normalizeTac(row[iTac], { allowZeroPadding: true })
      if (!tac) { stats.failed += 1; stats.failedSamples.length < 10 && stats.failedSamples.push({ reason: 'invalid TAC', raw: row.join(',').slice(0, 120) }); continue }
      if (tac !== clean(row[iTac])) stats.zeroPadded += 1
      const parsed = parseMoazEbRow(row[iBrand], row[iSpecs])
      records.push({ tac, ...parsed, sourceRecordDate: null })
    }
    return records
  },
}

export const osmocomSource = {
  name: 'osmocom',
  label: 'Osmocom TAC Database',
  url: 'https://tacdb.osmocom.org/',
  license: 'CC-BY-SA-3.0 (c) Harald Welte, Nico Golde, Kévin Redon 2014. Attribution and share-alike apply when redistributing.',
  priority: 1,
  async fetch({ file } = {}) {
    // SQLite carries a per-TAC submission date; CSV is the fallback when node:sqlite is unavailable.
    const sqlite = await import('node:sqlite').catch(() => null)
    const format = file ? (file.endsWith('.csv') ? 'csv' : 'sqlite') : sqlite ? 'sqlite' : 'csv'
    const location = file || `http://tacdb.osmocom.org/export/tacdb.${format === 'sqlite' ? 'sqlite3' : 'csv'}`
    const { buffer, lastModified } = file ? { buffer: await readFile(file), lastModified: null } : await download(location)
    return { buffer, format, sqlite, version: `sha256:${sha256(buffer).slice(0, 12)}`, sourceUpdatedAt: lastModified ? new Date(lastModified) : null, location }
  },
  async parse(buffer, stats, fetched) {
    const rawRows = fetched.format === 'sqlite' ? await readOsmocomSqlite(buffer, fetched.sqlite) : readOsmocomCsv(buffer)
    const records = []
    let newest = null
    for (const row of rawRows) {
      stats.discovered += 1
      const tac = normalizeTac(row.tac)
      if (!tac) { stats.failed += 1; stats.failedSamples.length < 10 && stats.failedSamples.push({ reason: 'invalid TAC', raw: JSON.stringify(row).slice(0, 120) }); continue }
      const date = row.date ? new Date(`${String(row.date).replace(' ', 'T')}Z`) : null
      const sourceRecordDate = date && !Number.isNaN(date.getTime()) ? date : null
      if (sourceRecordDate && (!newest || sourceRecordDate > newest)) newest = sourceRecordDate
      records.push({
        tac,
        brandName: normalizeBrand(row.brand),
        deviceName: normalizeDevice(stripBrandPrefix(row.model, row.brand)),
        modelNumber: '', // Osmocom has no model-number field; "aka" names are not reliable model numbers.
        releaseYear: null,
        sourceRecordDate,
      })
    }
    stats.newestSourceRecordDate = newest
    return records
  },
}

async function readOsmocomSqlite(buffer, sqlite) {
  if (!sqlite) throw new Error('node:sqlite is not available in this Node.js version; pass a CSV export instead.')
  // node:sqlite opens files only, so read from a private temporary copy.
  const dir = await mkdtemp(join(tmpdir(), 'osmocom-tacdb-'))
  const path = join(dir, 'tacdb.sqlite3')
  await writeFile(path, buffer)
  const db = new sqlite.DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(`SELECT t.tac AS tac, b.name AS brand, m.name AS model, t.date AS date
      FROM tac t LEFT JOIN model m ON m.id = t.model LEFT JOIN brand b ON b.id = m.brand`).all()
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
}

function readOsmocomCsv(buffer) {
  const rows = parseCsv(buffer.toString('utf8'))
  const headerIndex = rows.findIndex((row) => row[0]?.trim().toLowerCase() === 'tac')
  if (headerIndex < 0) throw new Error('Osmocom CSV header not found.')
  return rows.slice(headerIndex + 1).map((row) => ({ tac: row[0], brand: row[1], model: row[2], date: null }))
}

export const TAC_SOURCES = [moazEbSource, osmocomSource]
