// End-to-end tests for permanent IMEI uniqueness and edit/delete of stock, sales and dealers.
// Runs a real API server against a TEMPORARY database and drops it at the end.
//   npm run test:crud
import 'dotenv/config'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import mongoose from 'mongoose'

const testDb = `mobile_shop_test_crud_${Date.now()}`
const PORT = 5083
const uri = process.env.MAIN_MONGODB_URI || process.env.MONGODB_URI
const results = []
let server
let token = null
let cookies = ''

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['--no-warnings', 'server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(PORT), MAIN_MONGODB_DB: testDb, MONGODB_DB: testDb, NODE_ENV: 'test', FINANCIAL_PIN_RATE_LIMIT: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    const onData = (chunk) => { log += chunk; if (log.includes('API listening')) resolve(); if (log.includes('startup failed')) reject(new Error(log)) }
    server.stdout.on('data', onData)
    server.stderr.on('data', onData)
    server.on('exit', (code) => reject(new Error(`server exited ${code}: ${log}`)))
  })
}
async function req(path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    method,
    headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }), ...(cookies && { Cookie: cookies }) },
    ...(body && { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, text }
}
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }) } catch (error) { results.push({ name, ok: false, detail: error.message }) }
}
const check = (condition, message) => { if (!condition) throw new Error(message) }
function makeImei() {
  const body = `35${Array.from({ length: 12 }, () => crypto.randomInt(0, 10)).join('')}`
  let sum = 0
  for (let i = 13, dbl = true; i >= 0; i -= 1, dbl = !dbl) { let d = Number(body[i]); if (dbl) { d *= 2; if (d > 9) d -= 9 } sum += d }
  return body + String((10 - (sum % 10)) % 10)
}
const buy = (imei1, extra = {}) => req('/inventory', 'POST', { brand: 'Samsung', model: 'S24', imei1, purchaseDate: new Date().toISOString(), purchasePrice: 40000, ...extra })
const sell = (imei, extra = {}) => req('/sales', 'POST', { imei, sellingPrice: 50000, ...extra })

try {
  await mongoose.connect(uri, { dbName: testDb })
  await startServer()
  const password = crypto.randomBytes(18).toString('base64url')
  const setup = await req('/auth/setup', 'POST', { name: 'Test Owner', username: 'test_owner', password, setupKey: process.env.SETUP_KEY })
  check(setup.status === 201, `setup ${setup.text}`)
  token = setup.data.token
  const db = mongoose.connection.db
  const a = makeImei(); const b = makeImei(); const c = makeImei()
  let idA

  await test('A new IMEI is accepted', async () => { const r = await buy(a); check(r.status === 201, r.text); idA = r.data.item._id })
  await test('The same IMEI in stock is rejected and says so', async () => {
    const r = await buy(a)
    check(r.status === 409 && r.data.code === 'IMEI_ALREADY_EXISTS' && r.data.message.includes('already in stock'), r.text)
  })
  await test('An in-stock IMEI used as another phone\'s IMEI 2 is rejected', async () => { check((await buy(b, { imei2: a })).status === 409, 'not rejected') })
  await test('An in-stock IMEI 2 cannot be reused as IMEI 1', async () => {
    check((await buy(b, { imei2: c })).status === 201, 'setup')
    check((await buy(c)).status === 409, 'not rejected')
  })
  await test('IMEI 1 and IMEI 2 cannot be the same', async () => { const r = await buy(makeImei(), {}); check(r.status === 201, r.text); const d = makeImei(); const s = await buy(d, { imei2: d }); check(s.status === 400 && s.data.code === 'IMEI_REPEATED', s.text) })
  await test('check-imei reports in-stock', async () => { const r = await req(`/inventory/check-imei?imei=${a}`); check(r.data.exists && r.data.status === 'IN_STOCK', r.text) })
  await test('10 simultaneous adds of one IMEI create exactly one phone', async () => {
    const d = makeImei()
    const all = await Promise.all(Array.from({ length: 10 }, () => buy(d)))
    check(all.filter((r) => r.status === 201).length === 1, all.map((r) => r.status).join())
    check(await db.collection('inventories').countDocuments({ imeiKeys: d }) === 1, 'more than one record')
  })
  let saleId
  await test('A sold IMEI can never be added again', async () => {
    const s = await sell(a, { additionalExpenses: 500 }); check(s.status === 201, s.text); saleId = s.data.sale._id
    const r = await buy(a)
    check(r.status === 409 && r.data.message.includes('already been sold'), r.text)
    const again = await req(`/inventory/check-imei?imei=${a}`); check(again.data.status === 'SOLD', again.text)
  })
  await test('A sold phone cannot be sold twice', async () => { check((await sell(a)).status === 409, 'not rejected') })
  await test('Editing a phone to a sold or in-stock IMEI is rejected', async () => {
    const d = makeImei(); const r = await buy(d); const id = r.data.item._id
    check((await req(`/inventory/${id}`, 'PATCH', { imei1: a })).status === 409, 'sold IMEI allowed')
    check((await req(`/inventory/${id}`, 'PATCH', { imei2: b })).status === 409, 'in-stock IMEI allowed')
    check((await req(`/inventory/${id}`, 'PATCH', { imei2: d })).status === 400, 'repeated IMEI allowed')
  })
  await test('Stock edit saves all fields and the new IMEI', async () => {
    const d = makeImei(); const e = makeImei(); const r = await buy(d); const id = r.data.item._id
    const u = await req(`/inventory/${id}`, 'PATCH', { imei1: e, brand: 'Apple', model: 'iPhone', color: 'Blue', purchasePrice: 39000, dealerName: 'Manual', dealer: '' })
    check(u.status === 200, u.text)
    const f = u.data.item
    check(f.imei1 === e && f.brand === 'Apple' && f.color === 'Blue' && f.purchasePrice === 39000 && f.imeiLastSix[0] === e.slice(-6), JSON.stringify(f))
    check((await buy(d)).status === 201, 'old IMEI should be free after correction')
  })
  await test('Sold stock cannot be edited or deleted', async () => {
    check((await req(`/inventory/${idA}`, 'PATCH', { color: 'Red' })).status === 409, 'edited')
    check((await req(`/inventory/${idA}`, 'DELETE')).status === 409, 'deleted')
  })
  await test('Deleting a stock entry removes it', async () => {
    const d = makeImei(); const r = await buy(d)
    check((await req(`/inventory/${r.data.item._id}`, 'DELETE')).status === 200, 'delete')
    check((await req(`/inventory/${r.data.item._id}`)).status === 404, 'still there')
  })
  await test('Sale edit recalculates profit and updates the expense', async () => {
    const r = await req(`/sales/${saleId}`, 'PATCH', { sellingPrice: 52000, additionalExpenses: 700, customerName: 'Ravi', customerPhone: '999' })
    check(r.status === 200, r.text)
    const s = r.data.sale
    check(s.grossProfit === 12000 && s.netProfit === 11300 && s.customer.name === 'Ravi' && s.customer.phone === '999', JSON.stringify(s))
    const exp = await db.collection('expenses').find({ sale: new mongoose.Types.ObjectId(saleId) }).toArray()
    check(exp.length === 1 && exp[0].amount === 700, JSON.stringify(exp))
    const zero = await req(`/sales/${saleId}`, 'PATCH', { additionalExpenses: 0 })
    check(zero.data.sale.netProfit === 12000 && await db.collection('expenses').countDocuments({ sale: new mongoose.Types.ObjectId(saleId) }) === 0, 'expense not cleared')
  })
  await test('Sale edit rejects invalid amounts', async () => { check((await req(`/sales/${saleId}`, 'PATCH', { sellingPrice: 0 })).status === 400, 'accepted') })
  await test('Deleting a sale returns the phone to stock and keeps its IMEI taken', async () => {
    await req(`/sales/${saleId}`, 'PATCH', { additionalExpenses: 100 })
    check((await req(`/sales/${saleId}`, 'DELETE')).status === 200, 'delete')
    check((await req(`/sales/${saleId}`)).status === 404, 'sale remains')
    check((await req(`/inventory/${idA}`)).data.item.status === 'IN_STOCK', 'not in stock')
    check(await db.collection('expenses').countDocuments({ sale: new mongoose.Types.ObjectId(saleId) }) === 0, 'expense remains')
    check((await buy(a)).status === 409, 'IMEI became free')
  })
  await test('A restored phone can be sold again', async () => { const s = await sell(a); check(s.status === 201, s.text); saleId = s.data.sale._id })
  await test('Deleting an unknown sale is a 404', async () => { check((await req(`/sales/${new mongoose.Types.ObjectId()}`, 'DELETE')).status === 404, 'not 404') })
  await test('Dealer edit and delete work', async () => {
    const d = await req('/dealers', 'POST', { name: 'Old Name' })
    const u = await req(`/dealers/${d.data.dealer._id}`, 'PATCH', { name: 'New Name', phone: '123', address: 'Road' })
    check(u.status === 200 && u.data.dealer.name === 'New Name' && u.data.dealer.address === 'Road', u.text)
    check((await req(`/dealers/${d.data.dealer._id}`, 'DELETE')).data.message === 'Dealer deleted.', 'not deleted')
  })
  await test('With a PIN set and locked, sale edit and delete are refused', async () => {
    check((await req('/financial/pin', 'POST', { password, pin: '4821', confirmPin: '4821' })).status === 201, 'pin')
    await req('/financial/lock', 'POST')
    const edit = await req(`/sales/${saleId}`, 'PATCH', { sellingPrice: 1 })
    const del = await req(`/sales/${saleId}`, 'DELETE')
    check(edit.status === 403 && del.status === 403 && edit.data.code === 'FINANCIAL_PIN_REQUIRED', `${edit.status} ${del.status}`)
    check(await db.collection('sales').countDocuments({ _id: new mongoose.Types.ObjectId(saleId) }) === 1, 'sale changed')
  })
} catch (error) {
  results.push({ name: 'harness', ok: false, detail: error.message })
} finally {
  if (server && server.exitCode === null) await new Promise((resolve) => { server.removeAllListeners('exit'); server.once('exit', resolve); server.kill() })
  try {
    if (mongoose.connection.db?.databaseName === testDb) await mongoose.connection.db.dropDatabase()
  } catch (error) { console.error(`Could not drop ${testDb}: ${error.message}`) }
  await mongoose.disconnect()
}
for (const r of results) console.info(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`)
const failed = results.filter((r) => !r.ok).length
console.info(`\n${results.length - failed}/${results.length} passed`)
process.exitCode = failed ? 1 : 0
