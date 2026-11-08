// Tests for the hybrid TAC system. HiCellTek is mocked (no quota is used).
// DB scenarios run against temporary collections TACRecords_test / TACImportLogs_test, dropped afterwards.
//   node scripts/testTacSystem.js            # unit + DB tests
//   node scripts/testTacSystem.js --no-db    # unit tests only
import 'dotenv/config'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/database.js'
import { TACImportLog, TACRecord } from '../models/index.js'
import { identifyDevice, MANUAL_MESSAGE } from '../services/deviceLookup.js'
import { lookupWithHiCellTek, mapHiCellTekResponse } from '../services/hiCellTek.js'
import { runTacImport } from '../services/tac/importer.js'
import { moazEbSource, parseMoazEbRow } from '../services/tac/sources.js'
import { isValidImei } from '../validation.js'

const results = []
async function test(name, fn) {
  try { await fn(); results.push({ name, status: 'PASS' }) } catch (error) { results.push({ name, status: 'FAIL', detail: error.message }) }
}
const withLuhn = (body14) => {
  for (let d = 0; d <= 9; d += 1) if (isValidImei(`${body14}${d}`)) return `${body14}${d}`
  throw new Error('no check digit')
}
const S24 = { brandName: 'Samsung', deviceName: 'Galaxy S24', modelNumber: 'SM-S921B/DS' }
const remoteOk = async () => ({ data: S24, quota: { remaining: 7 } })
const remoteNotFound = async () => ({ data: null, quota: { remaining: 7 } })
const remoteFail = (code, message = code) => async () => { throw Object.assign(new Error(message), { code }) }
const neverCalled = async () => { throw new Error('HiCellTek must not be called') }

// The documented/observed HiCellTek response (live call on 2026-11-08 for TAC 35073866).
const liveShape = {
  found: true, tac: '35073866', brand: { name: 'SAMSUNG', slug: 'samsung' }, year: 2024,
  model: 'SAMSUNG GALAXY S24', marketing_name: 'Samsung Galaxy S24', model_info: 'Samsung SM-S921B/DS', meta: { remaining_lookups: 8 },
}

// ---------- 1-8: lookup paths ----------
const imei = withLuhn('35073866123456')
await test('1. TAC exists locally (complete) -> local_database, no API call', async () => {
  const r = await identifyDevice(imei, { findLocal: async () => ({ ...S24 }), lookupRemote: neverCalled })
  assert.equal(r.status, 200); assert.equal(r.body.source, 'local_database'); assert.deepEqual(r.body.data, S24)
})
await test('2. TAC missing locally, found in HiCellTek -> hicelltek_api', async () => {
  let sentTac
  const r = await identifyDevice(imei, { findLocal: async () => null, lookupRemote: async (tac) => { sentTac = tac; return remoteOk() } })
  assert.equal(sentTac, '35073866'); assert.equal(r.status, 200); assert.equal(r.body.source, 'hicelltek_api'); assert.deepEqual(r.body.data, S24)
})
await test('3. Local record missing model number -> HiCellTek fills it', async () => {
  const r = await identifyDevice(imei, { findLocal: async () => ({ brandName: 'Samsung', deviceName: 'Galaxy S24', modelNumber: '' }), lookupRemote: remoteOk })
  assert.equal(r.body.source, 'hicelltek_api'); assert.equal(r.body.data.modelNumber, 'SM-S921B/DS'); assert.equal(r.body.complete, true)
})
await test('3b. Local record incomplete and HiCellTek has nothing -> partial local data', async () => {
  const r = await identifyDevice(imei, { findLocal: async () => ({ brandName: 'Samsung', deviceName: 'Galaxy S24', modelNumber: '' }), lookupRemote: remoteNotFound })
  assert.equal(r.status, 200); assert.equal(r.body.source, 'local_database'); assert.equal(r.body.complete, false); assert.deepEqual(r.body.missingFields, ['modelNumber'])
})
await test('4. Neither source identifies the device -> 404 manual_entry', async () => {
  const r = await identifyDevice(imei, { findLocal: async () => null, lookupRemote: remoteNotFound })
  assert.equal(r.status, 404); assert.equal(r.body.source, 'manual_entry'); assert.equal(r.body.message, MANUAL_MESSAGE); assert.equal(r.body.data, null)
})
await test('5. Invalid IMEI (bad check digit / length / letters) -> 400', async () => {
  for (const bad of [`${imei.slice(0, 14)}${(Number(imei[14]) + 1) % 10}`, '12345', 'abcdefghijklmno']) {
    const r = await identifyDevice(bad, { findLocal: neverCalled, lookupRemote: neverCalled })
    assert.equal(r.status, 400)
  }
})
await test('6. Invalid HiCellTek key -> 502 manual_entry with hicelltek_auth', async () => {
  const r = await identifyDevice(imei, { findLocal: async () => null, lookupRemote: remoteFail('hicelltek_auth', 'HiCellTek rejected the API key. Check server configuration.') })
  assert.equal(r.status, 502); assert.equal(r.body.source, 'manual_entry'); assert.equal(r.body.fallbackError.code, 'hicelltek_auth')
  assert.ok(!JSON.stringify(r.body).includes(process.env.HICELLTEK_API_KEY || '__none__'))
})
await test('7. HiCellTek quota exceeded -> 429 manual_entry', async () => {
  const r = await identifyDevice(imei, { findLocal: async () => null, lookupRemote: remoteFail('hicelltek_quota') })
  assert.equal(r.status, 429); assert.equal(r.body.fallbackError.code, 'hicelltek_quota')
})
await test('8. MongoDB unavailable -> falls back to HiCellTek', async () => {
  const r = await identifyDevice(imei, { findLocal: remoteFail('db_unavailable'), lookupRemote: remoteOk })
  assert.equal(r.body.source, 'hicelltek_api'); assert.equal(r.body.localDatabaseAvailable, false)
})
await test('8b. MongoDB and HiCellTek both unavailable -> 503 manual_entry', async () => {
  const r = await identifyDevice(imei, { findLocal: remoteFail('db_unavailable'), lookupRemote: remoteFail('hicelltek_unreachable') })
  assert.equal(r.status, 503); assert.equal(r.body.source, 'manual_entry')
})

// ---------- HiCellTek client (fetch mocked) ----------
const realFetch = globalThis.fetch
const realKey = process.env.HICELLTEK_API_KEY
async function withFetch(impl, fn) {
  globalThis.fetch = impl; process.env.HICELLTEK_API_KEY = 'test-key'
  try { await fn() } finally { globalThis.fetch = realFetch; process.env.HICELLTEK_API_KEY = realKey }
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

await test('HiCellTek mapping uses brand.name / marketing_name / model_info', async () => {
  assert.deepEqual(mapHiCellTekResponse(liveShape), S24)
  assert.equal(mapHiCellTekResponse({ ...liveShape, marketing_name: undefined }).deviceName, 'Galaxy S24')
  assert.equal(mapHiCellTekResponse({ ...liveShape, model_info: undefined }).modelNumber, '')
  assert.equal(mapHiCellTekResponse({ found: false }), null)
})
await test('HiCellTek client sends TAC with X-Api-Key and maps response', async () => {
  await withFetch(async (url, init) => {
    assert.equal(init.headers['X-Api-Key'], 'test-key'); assert.deepEqual(JSON.parse(init.body), { query: '35073866' })
    return json(200, liveShape)
  }, async () => {
    const r = await lookupWithHiCellTek('35073866')
    assert.deepEqual(r.data, S24); assert.equal(r.quota.remaining, 8)
  })
})
await test('HiCellTek 401 -> hicelltek_auth error', async () => {
  await withFetch(async () => json(401, { message: 'Invalid API key' }), async () => {
    await assert.rejects(lookupWithHiCellTek('35073866'), (e) => e.code === 'hicelltek_auth')
  })
})
await test('HiCellTek 429 -> hicelltek_quota error with reset time', async () => {
  await withFetch(async () => json(429, { message: 'quota' }, { 'x-ratelimit-reset': '1794182400' }), async () => {
    await assert.rejects(lookupWithHiCellTek('35073866'), (e) => e.code === 'hicelltek_quota' && e.resetAt === '2026-11-09T00:00:00.000Z')
  })
})
await test('HiCellTek 404 found:false -> data null', async () => {
  await withFetch(async () => json(404, { found: false, tac: '35391012' }), async () => {
    assert.equal((await lookupWithHiCellTek('35391012')).data, null)
  })
})
await test('HiCellTek timeout -> hicelltek_timeout', async () => {
  process.env.HICELLTEK_TIMEOUT_MS = '50'
  const keepAlive = setTimeout(() => {}, 1000) // AbortSignal.timeout timers are unref'd
  await withFetch((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), async () => {
    await assert.rejects(lookupWithHiCellTek('35073866'), (e) => e.code === 'hicelltek_timeout')
  })
  clearTimeout(keepAlive)
  delete process.env.HICELLTEK_TIMEOUT_MS
})
await test('Concurrent lookups for one TAC share a single HiCellTek request', async () => {
  let calls = 0
  await withFetch(async () => { calls += 1; await new Promise((r) => setTimeout(r, 30)); return json(200, liveShape) }, async () => {
    await Promise.all([lookupWithHiCellTek('35073866'), lookupWithHiCellTek('35073866'), lookupWithHiCellTek('35073866')])
  })
  assert.equal(calls, 1)
})

// ---------- Parser ----------
await test('MoazEb parser separates model number and glued year without inventing values', async () => {
  assert.deepEqual(parseMoazEbRow('SAMSUNG', 'SAMSUNG GALAXY A56 5G, Samsung SM-A566B/DS2025'), { brandName: 'Samsung', deviceName: 'Galaxy A56 5G', modelNumber: 'SM-A566B/DS', releaseYear: 2025 })
  assert.deepEqual(parseMoazEbRow('APPLE', 'APPLE IPHONE 16E, Apple iPhone 16e, A3212, 2025'), { brandName: 'Apple', deviceName: 'iPhone 16E', modelNumber: 'A3212', releaseYear: 2025 })
  assert.equal(parseMoazEbRow('SAMSUNG', 'SAMSUNG, SAMSUNG GURU MUSIC 2').modelNumber, '')
  assert.equal(parseMoazEbRow('NOKIA', 'NOKIA, N/A, NOKIA THIS IS A TEST IMEI TO BE USED').deviceName, '')
})

// ---------- 9-11: import scenarios against temporary collections ----------
const csv = (rows) => Buffer.from(['Brand,TAC,SPECS', ...rows].join('\n'))
const fakeSource = (name, priority, buffer, parse) => ({
  name, label: name, url: 'test', license: 'test', priority,
  fetch: async () => ({ buffer, version: `${name}-v1`, sourceUpdatedAt: new Date('2026-10-01'), location: 'memory' }),
  parse: parse || moazEbSource.parse,
})
const secondary = (records) => async (_buffer, stats) => { stats.discovered += records.length; return records.map((r) => ({ releaseYear: null, sourceRecordDate: null, ...r })) }

if (!process.argv.includes('--no-db')) {
  await connectDatabase()
  const TestRecord = mongoose.model('TACRecordTest', TACRecord.schema.clone(), 'TACRecords_test')
  const TestLog = mongoose.model('TACImportLogTest', TACImportLog.schema.clone(), 'TACImportLogs_test')
  const opts = (sourceList) => ({ recordModel: TestRecord, logModel: TestLog, sourceList })
  try {
    await TestRecord.deleteMany({}); await TestLog.deleteMany({})
    const base = csv([
      'SAMSUNG,35073866,"SAMSUNG GALAXY S24, Samsung SM-S921B/DS2024"',
      'SAMSUNG,35073866,"SAMSUNG GALAXY S24, Samsung SM-S921B/DS2024"', // exact duplicate
      'VIVO,86967805,"VIVO V13 5G, Realme Chongqing RMX30412021"',
      'REALME,86967805,"VIVO V13 5G, Realme Chongqing RMX30412021"', // conflicting brand
      'APPLE,1242900,"APPLE IPHONE 4, Apple iPhone 4, A1332 - (3G Only), 2010"', // legacy TAC, zero padded
      'NOKIA,35899309,"NOKIA, NOKIA 105"', // no model number in source
      'BAD,12AB,"x"',
    ])
    let report
    await test('9. Duplicate TACs inside one import are collapsed', async () => {
      report = await runTacImport({ ...opts([fakeSource('moazeb', 2, base)]) })
      const s = report.sources[0]
      assert.equal(s.discovered, 7); assert.equal(s.failed, 1); assert.equal(s.duplicates, 1); assert.equal(s.conflicts, 1); assert.equal(s.zeroPadded, 1)
      assert.equal(await TestRecord.countDocuments({ tac: '35073866' }), 1)
      assert.equal(await TestRecord.countDocuments(), 4)
      assert.ok(await TestRecord.findOne({ tac: '01242900', modelNumber: 'A1332' }))
    })
    await test('10. Repeated import of the same snapshot changes nothing', async () => {
      const again = await runTacImport({ ...opts([fakeSource('moazeb', 2, base)]) })
      assert.equal(again.totals.imported, 0); assert.equal(again.totals.updated, 0); assert.equal(again.totals.unchanged, 4)
      assert.equal(await TestRecord.countDocuments(), 4)
    })
    await test('11. Conflicting sources: better/higher source wins, gaps filled, nothing blanked or deleted', async () => {
      // Lower-priority source: disagrees on 35073866 brand, adds a new TAC, and has an empty device for the Nokia TAC.
      const osmo = fakeSource('osmocom', 1, Buffer.from(''), secondary([
        { tac: '35073866', brandName: 'SciPhone', deviceName: 'Dream G2', modelNumber: '' },
        { tac: '35899309', brandName: 'Nokia', deviceName: '', modelNumber: '' },
        { tac: '49015420', brandName: 'Nokia', deviceName: '1610', modelNumber: '' },
      ]))
      // Newer moazeb snapshot that no longer lists 35899309.
      const newer = fakeSource('moazeb', 2, csv(['SAMSUNG,35073866,"SAMSUNG GALAXY S24, Samsung SM-S921B/DS2024"']))
      const r = await runTacImport({ ...opts([newer, osmo]) })
      assert.equal(r.crossSource.conflicts, 1)
      const s24 = await TestRecord.findOne({ tac: '35073866' }).lean()
      assert.equal(s24.brandName, 'Samsung'); assert.equal(s24.modelNumber, 'SM-S921B/DS')
      assert.deepEqual(s24.sources.map((x) => x.source).sort(), ['moazeb', 'osmocom'])
      const nokia = await TestRecord.findOne({ tac: '35899309' }).lean()
      assert.equal(nokia.deviceName, '105') // not blanked by the empty osmocom value, not deleted by the newer snapshot
      assert.ok(await TestRecord.findOne({ tac: '49015420', source: 'osmocom' }))
      assert.equal(await TestRecord.countDocuments(), 5)
    })
    await test('Concurrent imports are refused while one is running', async () => {
      const slow = { ...fakeSource('moazeb', 2, base), fetch: async () => { await new Promise((r) => setTimeout(r, 300)); return { buffer: base, version: 'slow' } } }
      const first = runTacImport({ ...opts([slow]) })
      await new Promise((r) => setTimeout(r, 100))
      await assert.rejects(runTacImport({ ...opts([slow]) }), (e) => e.status === 409)
      await first
    })
    await test('Import history is logged with per-source statistics', async () => {
      const logs = await TestLog.find({ status: 'completed' }).lean()
      assert.ok(logs.length >= 3); assert.ok(logs.every((l) => l.sources?.length && l.totals?.uniqueTacs >= 1))
    })
  } finally {
    await TestRecord.collection.drop().catch(() => {})
    await TestLog.collection.drop().catch(() => {})
    await mongoose.disconnect()
  }
}

for (const r of results) console.info(`${r.status}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`)
const failed = results.filter((r) => r.status === 'FAIL').length
console.info(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed ? 1 : 0
