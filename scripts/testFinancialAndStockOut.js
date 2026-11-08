// End-to-end tests for quick stock-out (IMEI last 6) and the financial PIN.
// Runs real API servers against a TEMPORARY database (mobile_shop_test_<timestamp>) on the same
// MongoDB cluster, creates a throwaway admin there, and drops that database at the end.
// The real database (MONGODB_DB) is never touched.
//   node scripts/testFinancialAndStockOut.js
import 'dotenv/config'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import mongoose from 'mongoose'

const testDb = `mobile_shop_test_${Date.now()}`
if (testDb === (process.env.MONGODB_DB || 'mobile_shop')) throw new Error('Refusing to run against the real database.')
const PORT = 5077
const FAST_PORT = 5078 // second server with a 3-second unlock window for the auto-lock test
const results = []
const servers = []

function startServer(port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(port), MONGODB_DB: testDb, NODE_ENV: 'test', FINANCIAL_PIN_RATE_LIMIT: '200', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    servers.push(child)
    let log = ''
    const onData = (chunk) => {
      log += chunk
      if (log.includes('API listening')) resolve(child)
      if (log.includes('startup failed')) reject(new Error(log))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${log}`)))
  })
}

/** Minimal HTTP client with a cookie jar and optional Bearer token (like the browser app). */
function client(port) {
  const jar = new Map()
  return {
    jar,
    token: null,
    async req(path, { method = 'GET', body, cookies = true } = {}) {
      const headers = { ...(body && { 'Content-Type': 'application/json' }), ...(this.token && { Authorization: `Bearer ${this.token}` }) }
      if (cookies && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers, ...(body && { body: JSON.stringify(body) }) })
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';')
        const [name, ...rest] = pair.split('=')
        const value = rest.join('=')
        const expired = !value || attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim()) || /max-age=0/i.test(a.trim()))
        if (expired) jar.delete(name.trim()); else jar.set(name.trim(), value)
      }
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { data = text }
      return { status: response.status, data, text, headers: response.headers }
    },
  }
}

async function test(group, name, fn) {
  try { await fn(); results.push({ group, name, status: 'PASS' }) } catch (error) { results.push({ group, name, status: 'FAIL', detail: error.message }) }
}
function check(condition, message) { if (!condition) throw new Error(message) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function luhnDigit(body14) {
  let sum = 0
  for (let i = body14.length - 1, dbl = true; i >= 0; i -= 1, dbl = !dbl) {
    let d = Number(body14[i])
    if (dbl) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return String((10 - (sum % 10)) % 10)
}
const randomDigits = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('')
const makeImei = () => { const b = `35${randomDigits(12)}`; return b + luhnDigit(b) }
/** A different valid IMEI that ends with the same 6 digits as `imei`. */
function sameLastSix(imei) {
  const tail = imei.slice(9, 14)
  for (let i = 0; i < 10000; i += 1) {
    const body = `86${randomDigits(7)}${tail}`
    if (luhnDigit(body) === imei[14] && body + imei[14] !== imei) return body + imei[14]
  }
  throw new Error('could not build a colliding IMEI')
}

const PIN = '4821'
const PASSWORD = crypto.randomBytes(18).toString('base64url')
const owner = client(PORT)
let dealerId
const phones = {}

try {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: testDb })
  await startServer(PORT)

  // Throwaway admin in the temporary database.
  const setup = await owner.req('/auth/setup', { method: 'POST', body: { name: 'Test Owner', username: 'test_owner', password: PASSWORD, setupKey: process.env.SETUP_KEY } })
  check(setup.status === 201, `setup failed ${setup.status} ${setup.text}`)
  owner.token = setup.data.token
  const dealer = await owner.req('/dealers', { method: 'POST', body: { name: 'Test Dealer' } })
  dealerId = dealer.data.dealer._id

  const buy = (imei, price, extra = {}) => owner.req('/inventory', { method: 'POST', body: { brand: 'Samsung', model: 'Galaxy S24', modelNumber: 'SM-S921B/DS', imei1: imei, purchaseDate: new Date().toISOString(), purchasePrice: price, dealer: dealerId, invoiceNumber: 'INV-1', ...extra } })

  // Before a PIN exists nothing is blocked (keeps the old frontend working until the owner opts in).
  await test('PIN', 'Before a PIN is set, behaviour is unchanged (stock entry works)', async () => {
    phones.a = makeImei(); phones.b = sameLastSix(phones.a); phones.c = makeImei(); phones.d = makeImei(); phones.e = makeImei()
    for (const [key, price] of [['a', 40000], ['b', 41000], ['c', 30000], ['d', 20000]]) {
      const r = await buy(phones[key], price)
      check(r.status === 201, `buy ${key} -> ${r.status} ${r.text}`)
      phones[`${key}Id`] = r.data.item._id
    }
    const status = await owner.req('/financial/status')
    check(status.data.pinEnabled === false, 'pin should not be enabled')
  })

  // ---------------- Financial PIN ----------------
  await test('PIN', '1. Set a 4-digit PIN (requires account password)', async () => {
    const wrongPassword = await owner.req('/financial/pin', { method: 'POST', body: { password: 'not-the-password', pin: PIN, confirmPin: PIN } })
    check(wrongPassword.status === 401, `wrong password -> ${wrongPassword.status}`)
    const r = await owner.req('/financial/pin', { method: 'POST', body: { password: PASSWORD, pin: PIN, confirmPin: PIN } })
    check(r.status === 201 && r.data.pinEnabled, `set -> ${r.status} ${r.text}`)
    const again = await owner.req('/financial/pin', { method: 'POST', body: { password: PASSWORD, pin: '1111', confirmPin: '1111' } })
    check(again.status === 409, `second setup should be 409, got ${again.status}`)
    await owner.req('/financial/lock', { method: 'POST' })
  })

  await test('PIN', 'PIN is stored only as a hash, never returned', async () => {
    const doc = await mongoose.connection.useDb(testDb).collection('usersecurity').findOne({})
    check(doc.financialPinHash && doc.financialPinHash !== PIN && doc.financialPinHash.startsWith('$2'), 'hash missing or plaintext')
    check(!JSON.stringify(doc).includes(`"${PIN}"`), 'plaintext PIN found in document')
    const status = await owner.req('/financial/status')
    check(!status.text.includes('financialPinHash') && !status.text.includes('$2'), 'hash leaked by status')
  })

  await test('PIN', '2. Reject invalid PIN formats', async () => {
    for (const bad of ['123', '12345', 'abcd', '12a4', '', ' 1234']) {
      const r = await owner.req('/financial/verify', { method: 'POST', body: { pin: bad } })
      check(r.status === 400, `"${bad}" -> ${r.status}`)
    }
    const numeric = await owner.req('/financial/verify', { method: 'POST', body: { pin: 4821 } })
    check(numeric.status === 400, `number type -> ${numeric.status}`)
  })

  await test('PIN', '5/7/12. Locked: no cost or profit via APIs; normal stock info still works', async () => {
    const inventory = await owner.req('/inventory?limit=10')
    check(inventory.status === 200 && inventory.data.items.length === 4, 'inventory list should work')
    check(inventory.data.items.every((i) => i.purchasePrice === null) && inventory.data.financialLocked, 'purchasePrice leaked in list')
    check(inventory.data.items.every((i) => i.brand && i.model && i.imei1), 'normal info missing')
    const one = await owner.req(`/inventory/${phones.aId}`)
    check(one.data.item.purchasePrice === null, 'purchasePrice leaked in detail')
    const sorted = await owner.req('/inventory?sort=priceDesc&limit=10')
    check(sorted.data.items[0].imei1 === phones.d, 'price sort should be ignored while locked (newest first)')
    const dashboard = await owner.req('/dashboard')
    const m = dashboard.data.metrics
    check(dashboard.status === 200 && m.available === 4, 'dashboard counts should work')
    check([m.purchaseInvestment, m.totalPurchaseAmount, m.grossProfit, m.netProfit, m.todayProfit].every((v) => v === null), 'dashboard leaked money')
    for (const path of ['/reports', '/reports/export.csv']) {
      const r = await owner.req(path)
      check(r.status === 403 && r.data.code === 'FINANCIAL_PIN_REQUIRED', `${path} -> ${r.status}`)
    }
    const dealers = await owner.req('/dealers')
    check(dealers.data.items[0].totalPurchaseAmount === null && dealers.data.items[0].purchaseCount === 4, 'dealer totals leaked')
    check(!inventory.text.includes('40000') && !dashboard.text.includes('131000'), 'raw cost figures in response text')
  })

  await test('PIN', '6. Entering or editing a purchase price requires the PIN', async () => {
    const add = await buy(phones.e, 15000)
    check(add.status === 403 && add.data.code === 'FINANCIAL_PIN_REQUIRED', `add -> ${add.status}`)
    const edit = await owner.req(`/inventory/${phones.cId}`, { method: 'PATCH', body: { purchasePrice: 1 } })
    check(edit.status === 403, `edit price -> ${edit.status}`)
    const editColor = await owner.req(`/inventory/${phones.cId}`, { method: 'PATCH', body: { color: 'Black' } })
    check(editColor.status === 200 && editColor.data.item.purchasePrice === null, `edit color -> ${editColor.status}`)
  })

  await test('PIN', '4. Reject incorrect PIN with a generic message', async () => {
    const r = await owner.req('/financial/verify', { method: 'POST', body: { pin: '0000' } })
    check(r.status === 401 && r.data.message === 'Incorrect PIN.', `${r.status} ${r.text}`)
    check(!owner.jar.has('shop_financial'), 'cookie set on failure')
  })

  await test('PIN', 'A forged client flag / bogus token does not unlock', async () => {
    const forged = client(PORT); forged.token = owner.token
    forged.jar.set('shop_financial', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid')
    const r = await forged.req('/reports?isPinVerified=true')
    check(r.status === 403, `forged -> ${r.status}`)
  })

  await test('PIN', '3. Correct PIN unlocks (HttpOnly cookie, 5 minutes, no token in body)', async () => {
    const r = await owner.req('/financial/verify', { method: 'POST', body: { pin: PIN } })
    check(r.status === 200 && r.data.unlocked, `${r.status} ${r.text}`)
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith('shop_financial='))
    check(/HttpOnly/i.test(cookie) && /Max-Age=300/i.test(cookie), `cookie attrs: ${cookie}`)
    check(!r.text.includes(owner.jar.get('shop_financial')), 'token returned in body')
    const ms = new Date(r.data.expiresAt) - Date.now()
    check(ms > 290000 && ms <= 300000, `expiry ${ms}`)
    const inventory = await owner.req('/inventory?limit=10')
    check(inventory.data.items.every((i) => typeof i.purchasePrice === 'number') && !inventory.data.financialLocked, 'still redacted after unlock')
    const reports = await owner.req('/reports')
    check(reports.status === 200 && reports.data.summary, 'reports blocked after unlock')
    const dashboard = await owner.req('/dashboard')
    check(dashboard.data.metrics.purchaseInvestment === 131000, `investment ${dashboard.data.metrics.purchaseInvestment}`)
  })

  await test('PIN', '6b. Purchase price entry works once unlocked', async () => {
    const add = await buy(phones.e, 15000)
    check(add.status === 201 && add.data.item.purchasePrice === 15000, `add -> ${add.status} ${add.text}`)
    phones.eId = add.data.item._id
  })

  await test('PIN', 'Unlock is bound to the login session (cookie replay with another login fails)', async () => {
    const login = await owner.req('/auth/login', { method: 'POST', body: { identifier: 'test_owner', password: PASSWORD } })
    const other = client(PORT); other.token = login.data.token
    other.jar.set('shop_financial', owner.jar.get('shop_financial'))
    const r = await other.req('/reports')
    check(r.status === 403, `replayed cookie on another session -> ${r.status}`)
  })

  // ---------------- Quick stock-out ----------------
  await test('Stock out', '2. Invalid characters / length rejected', async () => {
    for (const bad of ['12345', '1234567', '12a456', '', '12 456', '-12345']) {
      const r = await owner.req(`/inventory/search-imei-last-six?digits=${encodeURIComponent(bad)}`)
      check(r.status === 400, `"${bad}" -> ${r.status}`)
    }
  })
  await test('Stock out', '1. Search with valid last 6 digits (no cost fields)', async () => {
    const r = await owner.req(`/inventory/search-imei-last-six?digits=${phones.c.slice(-6)}`)
    check(r.status === 200 && r.data.total === 1, `${r.status} ${r.text}`)
    const item = r.data.items[0]
    check(item.imei1 === phones.c && item.brand === 'Samsung' && item.model && item.modelNumber && item.invoiceNumber === 'INV-1' && item.dealerName === 'Test Dealer' && item.status === 'IN_STOCK', 'fields missing')
    check(!('purchasePrice' in item), 'purchasePrice present in search result')
  })
  await test('Stock out', '3. No match -> clear message', async () => {
    let digits
    do digits = randomDigits(6); while (Object.values(phones).some((p) => String(p).endsWith(digits)))
    const r = await owner.req(`/inventory/search-imei-last-six?digits=${digits}`)
    check(r.status === 200 && r.data.total === 0 && r.data.message === 'No available phone found with these IMEI last 6 digits.', r.text)
  })
  await test('Stock out', '4. Multiple matches are all returned for explicit selection', async () => {
    const r = await owner.req(`/inventory/search-imei-last-six?digits=${phones.a.slice(-6)}`)
    check(r.data.total === 2, `expected 2, got ${r.data.total}`)
    check(new Set(r.data.items.map((i) => i.imei1)).size === 2 && r.data.items.every((i) => i.matchedImei.endsWith(phones.a.slice(-6))), 'wrong items')
  })
  await test('Stock out', '6. Sell a phone selected from a last-6 search', async () => {
    await owner.req('/financial/lock', { method: 'POST' }) // selling must work without the PIN
    const search = await owner.req(`/inventory/search-imei-last-six?digits=${phones.a.slice(-6)}`)
    const chosen = search.data.items.find((i) => i.imei1 === phones.b)
    const sale = await owner.req('/sales', { method: 'POST', body: { imei: chosen.matchedImei, sellingPrice: 45000, customerName: 'Walk-in' } })
    check(sale.status === 201, `${sale.status} ${sale.text}`)
    check(sale.data.sale.netProfit === null && sale.data.sale.purchasePrice === null && sale.data.sale.snapshot.purchasePrice === null, 'profit leaked in sale response while locked')
    const db = mongoose.connection.useDb(testDb)
    const stored = await db.collection('sales').findOne({ _id: new mongoose.Types.ObjectId(sale.data.sale._id) })
    check(stored.netProfit === 4000 && stored.purchasePrice === 41000, `server profit ${stored.netProfit}`)
  })
  await test('Stock out', '5. Sold phone is no longer offered', async () => {
    const r = await owner.req(`/inventory/search-imei-last-six?digits=${phones.a.slice(-6)}`)
    check(r.data.total === 1 && r.data.items[0].imei1 === phones.a, `remaining ${r.data.total}`)
    const again = await owner.req('/sales', { method: 'POST', body: { imei: phones.b, sellingPrice: 45000 } })
    check(again.status === 409, `resell -> ${again.status}`)
  })
  await test('Stock out', '7. Sell a phone using the full scanned IMEI (same endpoint)', async () => {
    const sale = await owner.req('/sales', { method: 'POST', body: { imei: phones.c, sellingPrice: 32000, additionalExpenses: 500 } })
    check(sale.status === 201, `${sale.status} ${sale.text}`)
  })
  await test('Stock out', '9. Simultaneous sale of the same phone -> exactly one succeeds', async () => {
    const attempts = await Promise.all(Array.from({ length: 5 }, () => owner.req('/sales', { method: 'POST', body: { imei: phones.d, sellingPrice: 22000 } })))
    const statuses = attempts.map((a) => a.status).sort()
    check(statuses.filter((s) => s === 201).length === 1, `statuses ${statuses}`)
    check(statuses.filter((s) => s === 409).length === 4, `losers must get 409, got ${statuses}`)
    const count = await mongoose.connection.useDb(testDb).collection('sales').countDocuments({ 'snapshot.imei1': phones.d })
    check(count === 1, `sales stored for phone d: ${count}`)
  })
  await test('Stock out', '8. Inventory, sales and profit reports reflect the sales', async () => {
    const inv = await owner.req('/inventory?limit=10')
    check(inv.data.total === 2, `in stock ${inv.data.total}`) // a + e
    const sold = await owner.req('/inventory?status=SOLD&limit=10')
    check(sold.data.total === 3, `sold ${sold.data.total}`)
    const sales = await owner.req('/sales?limit=10')
    check(sales.data.total === 3 && sales.data.items.every((s) => s.netProfit === null), 'sales list wrong or leaked')
    await owner.req('/financial/verify', { method: 'POST', body: { pin: PIN } })
    const reports = await owner.req('/reports')
    // b: 45000-41000=4000; c: 32000-30000-500=1500; d: 22000-20000=2000
    check(reports.data.summary.soldCount === 3 && reports.data.summary.netProfit === 7500, `report ${JSON.stringify(reports.data.summary)}`)
    const dashboard = await owner.req('/dashboard')
    check(dashboard.data.metrics.sold === 3 && dashboard.data.metrics.netProfit === 7500, 'dashboard wrong')
  })

  await test('PIN', '9. Manual lock revokes access immediately', async () => {
    const before = await owner.req('/reports')
    check(before.status === 200, 'should be unlocked first')
    const stolen = owner.jar.get('shop_financial')
    await owner.req('/financial/lock', { method: 'POST' })
    check((await owner.req('/reports')).status === 403, 'still unlocked after lock')
    owner.jar.set('shop_financial', stolen) // re-presenting the old cookie must not work
    check((await owner.req('/reports')).status === 403, 'old cookie accepted after lock')
    owner.jar.delete('shop_financial')
  })

  await test('PIN', '8. Automatic lock when the unlock window expires', async () => {
    await startServer(FAST_PORT, { FINANCIAL_UNLOCK_MINUTES: '0.05' }) // 3 seconds
    const fast = client(FAST_PORT); fast.token = owner.token
    const v = await fast.req('/financial/verify', { method: 'POST', body: { pin: PIN } })
    check(v.status === 200, `verify ${v.status}`)
    check((await fast.req('/reports')).status === 200, 'not unlocked')
    await sleep(3500)
    const status = await fast.req('/financial/status')
    check(status.data.unlocked === false, 'status still unlocked')
    const stale = client(FAST_PORT); stale.token = owner.token; stale.jar.set('shop_financial', fast.jar.get('shop_financial') || 'x')
    check((await stale.req('/reports')).status === 403, 'expired unlock still accepted')
  })

  await test('PIN', '10. Changing the PIN requires the current PIN', async () => {
    const wrong = await owner.req('/financial/pin', { method: 'PUT', body: { currentPin: '9999', newPin: '1357', confirmPin: '1357' } })
    check(wrong.status === 401, `wrong current -> ${wrong.status}`)
    const mismatch = await owner.req('/financial/pin', { method: 'PUT', body: { currentPin: PIN, newPin: '1357', confirmPin: '1358' } })
    check(mismatch.status === 400, `mismatch -> ${mismatch.status}`)
    const ok = await owner.req('/financial/pin', { method: 'PUT', body: { currentPin: PIN, newPin: '1357', confirmPin: '1357' } })
    check(ok.status === 200, `change -> ${ok.status} ${ok.text}`)
    check((await owner.req('/financial/verify', { method: 'POST', body: { pin: PIN } })).status === 401, 'old PIN still works')
    check((await owner.req('/financial/verify', { method: 'POST', body: { pin: '1357' } })).status === 200, 'new PIN rejected')
  })

  await test('PIN', 'Logout locks financial information', async () => {
    const stolen = owner.jar.get('shop_financial')
    await owner.req('/auth/logout', { method: 'POST' })
    const login = await owner.req('/auth/login', { method: 'POST', body: { identifier: 'test_owner', password: PASSWORD } })
    owner.token = login.data.token
    owner.jar.set('shop_financial', stolen)
    check((await owner.req('/reports')).status === 403, 'unlock survived logout')
    owner.jar.delete('shop_financial')
  })

  await test('PIN', '11. Repeated incorrect attempts trigger a temporary lockout', async () => {
    const statuses = []
    for (let i = 0; i < 6; i += 1) statuses.push((await owner.req('/financial/verify', { method: 'POST', body: { pin: '0001' } })).status)
    check(statuses.slice(0, 4).every((s) => s === 401) && statuses[4] === 429 && statuses[5] === 429, `statuses ${statuses}`)
    const correctWhileLocked = await owner.req('/financial/verify', { method: 'POST', body: { pin: '1357' } })
    check(correctWhileLocked.status === 429, `correct PIN during lockout -> ${correctWhileLocked.status}`)
    const events = await mongoose.connection.useDb(testDb).collection('auditlogs').find({ action: /FINANCIAL_PIN/ }).toArray()
    check(events.some((e) => e.action === 'FINANCIAL_PIN_LOCKOUT'), 'lockout not logged')
    check(!JSON.stringify(events).includes('0001') && !JSON.stringify(events).includes('1357'), 'PIN found in security log')
  })

  await test('PIN', 'Forgotten PIN reset needs password + recovery key', async () => {
    const denied = await owner.req('/financial/pin/reset', { method: 'POST', body: { password: PASSWORD, recoveryKey: 'wrong', newPin: '2468', confirmPin: '2468' } })
    check(denied.status === 401, `wrong key -> ${denied.status}`)
    const ok = await owner.req('/financial/pin/reset', { method: 'POST', body: { password: PASSWORD, recoveryKey: process.env.FINANCIAL_PIN_RECOVERY_KEY || process.env.SETUP_KEY, newPin: '2468', confirmPin: '2468' } })
    check(ok.status === 200, `reset -> ${ok.status} ${ok.text}`)
    check((await owner.req('/financial/verify', { method: 'POST', body: { pin: '2468' } })).status === 200, 'new PIN after reset failed (lockout should be cleared)')
  })

  await test('Stock out', 'Existing records are backfilled for last-6 search on startup', async () => {
    const db = mongoose.connection.useDb(testDb)
    await db.collection('inventories').updateOne({ imei1: phones.a }, { $unset: { imeiLastSix: '' } })
    await startServer(5079)
    const restarted = client(5079); restarted.token = owner.token
    const r = await restarted.req(`/inventory/search-imei-last-six?digits=${phones.a.slice(-6)}`)
    check(r.data.total === 1, `after backfill ${r.data.total}`)
  })
} catch (error) {
  results.push({ group: 'setup', name: 'test harness', status: 'FAIL', detail: error.message })
} finally {
  // Wait for the servers to exit so no in-flight write re-creates the temporary database after the drop.
  await Promise.all(servers.map((child) => (child.exitCode !== null ? null : new Promise((resolve) => { child.once('exit', resolve); child.kill() }))))
  try {
    if (!mongoose.connection.readyState) await mongoose.connect(process.env.MONGODB_URI, { dbName: testDb })
    if (mongoose.connection.db.databaseName === testDb) await mongoose.connection.db.dropDatabase()
    else console.error('Refusing to drop a non-test database.')
  } catch (error) { console.error(`Could not drop ${testDb}: ${error.message}`) }
  await mongoose.disconnect()
}

for (const r of results) console.info(`${r.status}  [${r.group}] ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`)
const failed = results.filter((r) => r.status === 'FAIL').length
console.info(`\n${results.length - failed}/${results.length} passed (temporary database ${testDb} dropped)`)
process.exitCode = failed ? 1 : 0
