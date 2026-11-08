// End-to-end tests: two clusters + purchase invoices + stock inward.
// Starts real API servers against TEMPORARY databases on BOTH clusters (dropped at the end):
//   main cluster: mobile_shop_invtest_<ts>     TAC cluster: mobile_shop_tac_invtest_<ts>
// Lookup tests read the real TAC database on the TAC cluster (read-only). No HiCellTek calls are made
// except one, only when --live-hicelltek is passed.
//   node scripts/testPurchaseInvoices.js [--live-hicelltek]
import 'dotenv/config'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { mainConfig, tacConfig } from '../config/database.js'

const stamp = Date.now()
const MAIN_DB = `mobile_shop_invtest_${stamp}`
const TAC_DB = `mobile_shop_tac_invtest_${stamp}`
const REAL_TAC_DB = process.env.TAC_MONGODB_DB || 'mobile_shop_tac'
const results = []
const servers = []
const host = (uri) => String(uri).split('@').pop().split('/')[0].split('?')[0]

function startServer(port, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, PORT: String(port), MAIN_MONGODB_DB: MAIN_DB, MONGODB_DB: MAIN_DB, TAC_MONGODB_DB: TAC_DB, NODE_ENV: 'test', FINANCIAL_PIN_RATE_LIMIT: '500', HICELLTEK_API_KEY: '', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    servers.push(child)
    let log = ''
    const onData = (chunk) => { log += chunk; if (log.includes('API listening')) resolve(child); if (log.includes('startup failed')) reject(new Error(log)) }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${log}`)))
  })
}
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 300)) } return false }

function client(port) {
  const jar = new Map()
  return {
    token: null,
    async req(path, { method = 'GET', body, form, raw = false } = {}) {
      const headers = { ...(body && { 'Content-Type': 'application/json' }), ...(this.token && { Authorization: `Bearer ${this.token}` }) }
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers, body: form || (body && JSON.stringify(body)) })
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';'); const [name, ...rest] = pair.split('='); const value = rest.join('=')
        if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(name.trim()); else jar.set(name.trim(), value)
      }
      if (raw) return { status: response.status, headers: response.headers, buffer: Buffer.from(await response.arrayBuffer()) }
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { data = text }
      return { status: response.status, data, text }
    },
  }
}
async function test(name, fn) {
  try { await fn(); results.push({ name, status: 'PASS' }) } catch (error) { results.push({ name, status: 'FAIL', detail: error.message }) }
}
const check = (condition, message) => { if (!condition) throw new Error(message) }
const luhn = (b) => { let s = 0; for (let i = b.length - 1, d = true; i >= 0; i--, d = !d) { let n = +b[i]; if (d) { n *= 2; if (n > 9) n -= 9 } s += n } return String((10 - s % 10) % 10) }
const imei = (prefix = '35') => { const b = prefix + Array.from({ length: 14 - prefix.length }, () => crypto.randomInt(10)).join(''); return b + luhn(b) }
const pdf = (text = 'invoice') => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${text}\ntrailer<</Root 1 0 R>>\n%%EOF\n`)
function invoiceForm(fields, file) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v))
  if (file) form.append('invoiceFile', new Blob([file.buffer], { type: file.type }), file.name)
  return form
}

const PASSWORD = crypto.randomBytes(18).toString('base64url')
const PIN = '4821'
const A = client(5091)
let mainConn
let tacConn

try {
  mainConn = await mongoose.createConnection(mainConfig().uri, { dbName: MAIN_DB }).asPromise()
  tacConn = await mongoose.createConnection(tacConfig().uri, { dbName: TAC_DB }).asPromise()
  await startServer(5091)
  check(await waitFor(async () => (await A.req('/health')).data?.databases?.tac === 'connected'), 'TAC connection did not come up')
  const setup = await A.req('/auth/setup', { method: 'POST', body: { name: 'Invoice Owner', username: 'inv_owner', password: PASSWORD, setupKey: process.env.SETUP_KEY } })
  check(setup.status === 201, `setup ${setup.status} ${setup.text}`)
  A.token = setup.data.token
  const samsungDealer = (await A.req('/dealers', { method: 'POST', body: { name: 'Samsung Supplier' } })).data.dealer
  const otherDealer = (await A.req('/dealers', { method: 'POST', body: { name: 'City Phones' } })).data.dealer
  const addPhone = (invoice, extra = {}) => A.req('/inventory', { method: 'POST', body: { brand: 'Samsung', model: 'Galaxy A56 5G', modelNumber: 'SM-A566B/DS', imei1: imei(), purchasePrice: 5000, purchaseInvoiceId: invoice, ...extra } })
  const getInvoice = async (id) => (await A.req(`/purchase-invoices/${id}`)).data.invoice
  let inv
  let pdfBytes

  // ---------------- Clusters ----------------
  await test('1. Two separate MongoDB clusters are connected', async () => {
    const health = await A.req('/health')
    check(health.data.databases.main === 'connected' && health.data.databases.tac === 'connected' && health.data.databases.tacCluster === 'separate', JSON.stringify(health.data))
    check(host(mainConfig().uri) !== host(tacConfig().uri), 'same host')
    const [m, t] = await Promise.all([mainConn.db.admin().command({ hello: 1 }), tacConn.db.admin().command({ hello: 1 })])
    check(m.setName !== t.setName, `same replica set ${m.setName}`)
  })
  await test('2. TAC records live on the TAC cluster and lookups use it', async () => {
    const realTac = tacConn.useDb(REAL_TAC_DB)
    const count = await realTac.collection('TACRecords').estimatedDocumentCount()
    check(count >= 275000, `TAC cluster TACRecords = ${count}`)
    // This server's MAIN database is brand new (no TAC data), so a local hit must come from the TAC cluster.
    await startServer(5093, { TAC_MONGODB_DB: REAL_TAC_DB })
    const C = client(5093); C.token = A.token
    await waitFor(async () => (await C.req('/health')).data?.databases?.tac === 'connected')
    const imeiFor = (tac) => { for (let d = 0; d < 10; d++) { const v = `${tac}123456${d}`; if (luhn(v.slice(0, 14)) === v[14]) return v } }
    const r = await C.req('/device-lookup', { method: 'POST', body: { imei: imeiFor('35073866') } })
    check(r.status === 200 && r.data.source === 'local_database' && r.data.data.modelNumber === 'SM-S921B/DS', JSON.stringify(r.data))
    check(!(await mainConn.db.listCollections({ name: 'TACRecords' }).toArray()).length, 'TACRecords created on main test DB')
  })

  // ---------------- Invoices ----------------
  await test('4/5. Create a 20-phone invoice with a PDF; file stored in GridFS on the TAC cluster', async () => {
    pdfBytes = pdf('INV-1025 Samsung Supplier')
    const r = await A.req('/purchase-invoices', { method: 'POST', form: invoiceForm({ dealer: samsungDealer._id, invoiceNumber: 'INV-1025', invoiceDate: '2026-11-08', totalPurchaseAmount: 100000, totalQuantity: 20, brand: 'Samsung' }, { buffer: pdfBytes, type: 'application/pdf', name: 'INV-1025.pdf' }) })
    check(r.status === 201, `${r.status} ${r.text}`)
    inv = r.data.invoice
    check(inv.totalQuantity === 20 && inv.addedQuantity === 0 && inv.remainingQuantity === 20 && inv.status === 'Pending', JSON.stringify(inv))
    check(inv.attachment?.mimeType === 'application/pdf' && !JSON.stringify(inv).includes('fileId'), 'attachment metadata wrong or storage id exposed')
    const files = await tacConn.db.collection('invoiceFiles.files').find({}).toArray()
    check(files.length === 1 && files[0].length === pdfBytes.length, `GridFS files ${files.length}`)
    const download = await A.req(`/purchase-invoices/${inv._id}/attachment?download=1`, { raw: true })
    check(download.status === 200 && download.buffer.equals(pdfBytes) && /attachment/.test(download.headers.get('content-disposition')), `download ${download.status}`)
  })
  await test('3. Application data stays on the main cluster', async () => {
    const mainNames = (await mainConn.db.listCollections().toArray()).map((c) => c.name)
    const tacNames = (await tacConn.db.listCollections().toArray()).map((c) => c.name)
    check(['purchaseinvoices', 'dealers', 'users'].every((n) => mainNames.includes(n)), `main: ${mainNames}`)
    check(!tacNames.some((n) => ['purchaseinvoices', 'dealers', 'users', 'inventories', 'sales'].includes(n)), `tac: ${tacNames}`)
    check(!mainNames.some((n) => n.startsWith('invoiceFiles')), 'invoice files on main')
  })
  await test('Rejects wrong file types and oversized files', async () => {
    const fake = await A.req('/purchase-invoices', { method: 'POST', form: invoiceForm({ dealer: otherDealer._id, invoiceNumber: 'BAD-1', invoiceDate: '2026-11-08', totalPurchaseAmount: 1, totalQuantity: 1 }, { buffer: Buffer.from('not really a pdf'), type: 'application/pdf', name: 'fake.pdf' }) })
    check(fake.status === 415, `fake pdf -> ${fake.status}`)
    const exe = await A.req('/purchase-invoices', { method: 'POST', form: invoiceForm({ dealer: otherDealer._id, invoiceNumber: 'BAD-2', invoiceDate: '2026-11-08', totalPurchaseAmount: 1, totalQuantity: 1 }, { buffer: Buffer.from('MZ'), type: 'application/octet-stream', name: 'x.exe' }) })
    check(exe.status === 415, `exe -> ${exe.status}`)
    const big = await A.req('/purchase-invoices', { method: 'POST', form: invoiceForm({ dealer: otherDealer._id, invoiceNumber: 'BAD-3', invoiceDate: '2026-11-08', totalPurchaseAmount: 1, totalQuantity: 1 }, { buffer: Buffer.concat([pdf(), Buffer.alloc(9 * 1024 * 1024)]), type: 'application/pdf', name: 'big.pdf' }) })
    check(big.status === 413, `big -> ${big.status}`)
    check(!(await mainConn.db.collection('purchaseinvoices').countDocuments({ invoiceNumber: /^BAD-/ })), 'rejected invoice saved')
    check(await tacConn.db.collection('invoiceFiles.files').countDocuments() === 1, 'orphan files stored')
  })
  await test('11. Same invoice number for another dealer is allowed', async () => {
    const r = await A.req('/purchase-invoices', { method: 'POST', body: { dealer: otherDealer._id, invoiceNumber: 'INV-1025', invoiceDate: '2026-11-07', totalPurchaseAmount: 30000, totalQuantity: 5 } })
    check(r.status === 201, `${r.status} ${r.text}`)
  })
  await test('12. Duplicate invoice number for the same dealer is rejected (case/space-insensitive)', async () => {
    for (const number of ['INV-1025', 'inv-1025', ' INV - 1025 ']) {
      const r = await A.req('/purchase-invoices', { method: 'POST', body: { dealer: samsungDealer._id, invoiceNumber: number, invoiceDate: '2026-11-08', totalPurchaseAmount: 1, totalQuantity: 1 } })
      check(r.status === 409 && r.data.code === 'DUPLICATE_INVOICE', `"${number}" -> ${r.status}`)
    }
  })
  let firstPhone
  await test('6/7/10. First phone: 1 added, 19 remaining; dealer/invoice/date come from the invoice', async () => {
    const r = await addPhone(inv._id, { dealer: otherDealer._id, dealerName: 'Wrong', invoiceNumber: 'WRONG', purchaseDate: '2020-01-01' })
    check(r.status === 201, `${r.status} ${r.text}`)
    firstPhone = r.data.item
    check(String(firstPhone.purchaseInvoiceId) === inv._id && String(firstPhone.dealer) === samsungDealer._id && firstPhone.dealerName === 'Samsung Supplier' && firstPhone.invoiceNumber === 'INV-1025' && firstPhone.purchaseDate.startsWith('2026-11-08'), JSON.stringify(firstPhone))
    const now = await getInvoice(inv._id)
    check(now.addedQuantity === 1 && now.remainingQuantity === 19 && now.status === 'Partially Added', JSON.stringify(now))
  })
  await test('Available-for-stock dropdown lists the invoice with remaining quantity, no amounts', async () => {
    const r = await A.req('/purchase-invoices/available-for-stock?search=inv-10')
    const row = r.data.items.find((i) => i._id === inv._id)
    check(row && row.remainingQuantity === 19 && row.dealerName === 'Samsung Supplier' && !('totalPurchaseAmount' in row), JSON.stringify(row))
  })
  await test('Duplicate IMEI on an invoice is rejected and does not change the count', async () => {
    const r = await addPhone(inv._id, { imei1: firstPhone.imei1 })
    check(r.status === 409, `${r.status}`)
    check((await getInvoice(inv._id)).addedQuantity === 1, 'count changed')
  })
  await test('8. Add 19 more phones -> Completed (20/20, 0 remaining)', async () => {
    for (let i = 0; i < 19; i++) { const r = await addPhone(inv._id); check(r.status === 201, `phone ${i + 2}: ${r.status} ${r.text}`) }
    const now = await getInvoice(inv._id)
    check(now.addedQuantity === 20 && now.remainingQuantity === 0 && now.status === 'Completed', JSON.stringify(now))
    const avail = await A.req('/purchase-invoices/available-for-stock')
    check(!avail.data.items.some((i) => i._id === inv._id), 'completed invoice still offered')
  })
  await test('9. A 21st phone is rejected', async () => {
    const r = await addPhone(inv._id)
    check(r.status === 409 && r.data.code === 'INVOICE_QUANTITY_EXCEEDED', `${r.status} ${r.text}`)
    check(await mainConn.db.collection('inventories').countDocuments({ purchaseInvoiceId: new mongoose.Types.ObjectId(inv._id) }) === 20, 'extra phone stored')
  })
  await test('Concurrent entries can never exceed the invoice quantity', async () => {
    const small = (await A.req('/purchase-invoices', { method: 'POST', body: { dealer: samsungDealer._id, invoiceNumber: 'RACE-1', invoiceDate: '2026-11-08', totalPurchaseAmount: 25000, totalQuantity: 5 } })).data.invoice
    const attempts = await Promise.all(Array.from({ length: 12 }, () => addPhone(small._id)))
    const ok = attempts.filter((a) => a.status === 201).length
    const now = await getInvoice(small._id)
    const linked = await mainConn.db.collection('inventories').countDocuments({ purchaseInvoiceId: new mongoose.Types.ObjectId(small._id) })
    check(ok === 5 && now.addedQuantity === 5 && now.remainingQuantity === 0 && linked === 5, `ok=${ok} added=${now.addedQuantity} linked=${linked} statuses=${attempts.map((a) => a.status)}`)
  })
  await test('13. Deleting a linked in-stock phone restores the invoice quantity', async () => {
    const r = await A.req(`/inventory/${firstPhone._id}`, { method: 'DELETE' })
    check(r.status === 200, `${r.status} ${r.text}`)
    const now = await getInvoice(inv._id)
    check(now.addedQuantity === 19 && now.remainingQuantity === 1 && now.status === 'Partially Added', JSON.stringify(now))
  })
  await test('14. Invoice quantity cannot go below linked phones; raising it updates remaining', async () => {
    const low = await A.req(`/purchase-invoices/${inv._id}`, { method: 'PUT', body: { totalQuantity: 18 } })
    check(low.status === 409 && low.data.code === 'QUANTITY_BELOW_ADDED', `${low.status} ${low.text}`)
    const up = await A.req(`/purchase-invoices/${inv._id}`, { method: 'PUT', body: { totalQuantity: 22 } })
    check(up.status === 200 && up.data.invoice.remainingQuantity === 3 && up.data.invoice.addedQuantity === 19, up.text)
    const back = await A.req(`/purchase-invoices/${inv._id}`, { method: 'PUT', body: { totalQuantity: 20 } })
    check(back.data.invoice.remainingQuantity === 1, back.text)
  })
  await test('Moving a phone between invoices updates both; moving into a full invoice is refused', async () => {
    const target = (await A.req('/purchase-invoices', { method: 'POST', body: { dealer: otherDealer._id, invoiceNumber: 'MOVE-1', invoiceDate: '2026-11-06', totalPurchaseAmount: 10000, totalQuantity: 2 } })).data.invoice
    const phone = (await A.req(`/purchase-invoices/${inv._id}/stock?limit=1`)).data.items[0]
    const moved = await A.req(`/inventory/${phone._id}`, { method: 'PATCH', body: { purchaseInvoiceId: target._id } })
    check(moved.status === 200 && moved.data.item.dealerName === 'City Phones' && moved.data.item.invoiceNumber === 'MOVE-1', moved.text)
    check((await getInvoice(inv._id)).addedQuantity === 18 && (await getInvoice(target._id)).addedQuantity === 1, 'counts after move')
    const full = (await A.req('/purchase-invoices', { method: 'POST', body: { dealer: otherDealer._id, invoiceNumber: 'FULL-1', invoiceDate: '2026-11-06', totalPurchaseAmount: 1, totalQuantity: 1 } })).data.invoice
    check((await addPhone(full._id)).status === 201, 'fill FULL-1')
    const refused = await A.req(`/inventory/${phone._id}`, { method: 'PATCH', body: { purchaseInvoiceId: full._id } })
    check(refused.status === 409, `into full -> ${refused.status}`)
    check((await getInvoice(target._id)).addedQuantity === 1 && (await getInvoice(full._id)).addedQuantity === 1, 'failed move changed counts')
    const managed = await A.req(`/inventory/${phone._id}`, { method: 'PATCH', body: { dealer: samsungDealer._id } })
    check(managed.status === 409 && managed.data.code === 'MANAGED_BY_INVOICE', `dealer edit -> ${managed.status}`)
    const back = await A.req(`/inventory/${phone._id}`, { method: 'PATCH', body: { purchaseInvoiceId: inv._id } })
    check(back.status === 200 && (await getInvoice(inv._id)).addedQuantity === 19 && (await getInvoice(target._id)).addedQuantity === 0, 'move back')
  })
  await test('Editing invoice number/date updates the linked phones', async () => {
    const r = await A.req(`/purchase-invoices/${inv._id}`, { method: 'PUT', body: { invoiceNumber: 'INV-1025A', invoiceDate: '2026-11-09' } })
    check(r.status === 200, r.text)
    const phones = await mainConn.db.collection('inventories').find({ purchaseInvoiceId: new mongoose.Types.ObjectId(inv._id) }).toArray()
    check(phones.length === 19 && phones.every((p) => p.invoiceNumber === 'INV-1025A' && p.purchaseDate.toISOString().startsWith('2026-11-09')), 'snapshots not updated')
  })
  await test('15. Selling a linked phone does not restore invoice quantity', async () => {
    const phone = (await A.req(`/purchase-invoices/${inv._id}/stock?limit=1`)).data.items[0]
    const sale = await A.req('/sales', { method: 'POST', body: { imei: phone.imei1, sellingPrice: 6500 } })
    check(sale.status === 201, sale.text)
    const now = await getInvoice(inv._id)
    check(now.addedQuantity === 19 && now.remainingQuantity === 1, JSON.stringify(now))
    const del = await A.req(`/inventory/${phone._id}`, { method: 'DELETE' })
    check(del.status === 409, `deleting sold -> ${del.status}`)
  })
  await test('16. Stock without an invoice still works (create, edit dealer, sell)', async () => {
    const r = await A.req('/inventory', { method: 'POST', body: { brand: 'Nokia', model: '105', imei1: imei(), purchasePrice: 900, purchaseDate: '2026-11-01', dealer: otherDealer._id, invoiceNumber: 'OLD-1' } })
    check(r.status === 201 && r.data.item.purchaseInvoiceId === null, r.text)
    const edit = await A.req(`/inventory/${r.data.item._id}`, { method: 'PATCH', body: { dealer: samsungDealer._id } })
    check(edit.status === 200 && edit.data.item.dealerName === 'Samsung Supplier', edit.text)
    const noDate = await A.req('/inventory', { method: 'POST', body: { brand: 'Nokia', model: '105', imei1: imei(), purchasePrice: 900 } })
    check(noDate.status === 400, `no date & no invoice -> ${noDate.status}`)
    const sale = await A.req('/sales', { method: 'POST', body: { imei: r.data.item.imei1, sellingPrice: 1200 } })
    check(sale.status === 201, sale.text)
  })
  await test('17. Invoice totals are not counted in profit reports', async () => {
    const report = (await A.req('/reports')).data.summary
    // Sold: one invoice phone (cost 5000, sold 6500) + Nokia (900 -> 1200). Invoice totals (100000, 30000, ...) must not appear.
    check(report.soldCount === 2 && report.purchaseAmount === 5900 && report.netProfit === 1800, JSON.stringify(report))
    const dashboard = (await A.req('/dashboard')).data.metrics
    const inventoryCost = (await mainConn.db.collection('inventories').aggregate([{ $group: { _id: null, t: { $sum: '$purchasePrice' } } }]).toArray())[0].t
    check(dashboard.totalPurchaseAmount === inventoryCost, `dashboard ${dashboard.totalPurchaseAmount} vs phones ${inventoryCost}`)
    const detail = (await A.req(`/purchase-invoices/${inv._id}`)).data
    check(detail.invoice.totalPurchaseAmount === 100000 && detail.linkedPurchaseTotal === 19 * 5000 && detail.linkedStock.sold === 1 && detail.linkedStock.inStock === 18, JSON.stringify(detail))
  })

  // ---------------- Financial PIN ----------------
  await test('18. Invoice amounts and attachments need the Financial PIN; quantities do not', async () => {
    const set = await A.req('/financial/pin', { method: 'POST', body: { password: PASSWORD, pin: PIN, confirmPin: PIN } })
    check(set.status === 201, set.text)
    await A.req('/financial/lock', { method: 'POST' })
    const list = await A.req('/purchase-invoices')
    check(list.data.financialLocked && list.data.items.every((i) => i.totalPurchaseAmount === null) && list.data.items.every((i) => Number.isInteger(i.remainingQuantity)), 'list leaked or lost quantities')
    check(!list.text.includes('100000'), 'amount in list text')
    const detail = await A.req(`/purchase-invoices/${inv._id}`)
    check(detail.data.invoice.totalPurchaseAmount === null && detail.data.linkedPurchaseTotal === null && detail.data.invoice.remainingQuantity === 1, 'detail leaked')
    const stock = await A.req(`/purchase-invoices/${inv._id}/stock`)
    check(stock.data.items.every((p) => p.purchasePrice === null), 'phone cost leaked')
    check((await A.req(`/purchase-invoices/${inv._id}/attachment`)).status === 403, 'attachment open while locked')
    check((await A.req('/purchase-invoices', { method: 'POST', body: { dealer: samsungDealer._id, invoiceNumber: 'LOCK-1', invoiceDate: '2026-11-08', totalPurchaseAmount: 1, totalQuantity: 1 } })).status === 403, 'create while locked')
    check((await A.req(`/purchase-invoices/${inv._id}`, { method: 'PUT', body: { totalPurchaseAmount: 1 } })).status === 403, 'amount edit while locked')
    check((await A.req(`/purchase-invoices/${inv._id}`, { method: 'PUT', body: { notes: 'Checked by staff' } })).status === 200, 'notes edit should work')
    check((await A.req('/purchase-invoices/available-for-stock')).status === 200, 'dropdown blocked')
    await A.req('/financial/verify', { method: 'POST', body: { pin: PIN } })
    check((await A.req(`/purchase-invoices/${inv._id}`)).data.invoice.totalPurchaseAmount === 100000, 'unlock did not reveal')
    check((await A.req(`/purchase-invoices/${inv._id}/attachment`, { raw: true })).buffer.equals(pdfBytes), 'attachment after unlock')
  })
  await test('Attachment replacement removes the old file; invoice with stock cannot be deleted; empty one can', async () => {
    const newPdf = pdf('replacement scan')
    const r = await A.req(`/purchase-invoices/${inv._id}`, { method: 'PUT', form: invoiceForm({}, { buffer: newPdf, type: 'application/pdf', name: 'rescan.pdf' }) })
    check(r.status === 200 && r.data.invoice.attachment.originalName === 'rescan.pdf', r.text)
    check(await tacConn.db.collection('invoiceFiles.files').countDocuments() === 1, 'old file not removed')
    check((await A.req(`/purchase-invoices/${inv._id}/attachment`, { raw: true })).buffer.equals(newPdf), 'new file not served')
    check((await A.req(`/purchase-invoices/${inv._id}`, { method: 'DELETE' })).status === 409, 'deleted invoice with stock')
    const empty = (await A.req('/purchase-invoices', { method: 'POST', form: invoiceForm({ dealer: samsungDealer._id, invoiceNumber: 'EMPTY-1', invoiceDate: '2026-11-08', totalPurchaseAmount: 10, totalQuantity: 3 }, { buffer: pdf('x'), type: 'application/pdf', name: 'e.pdf' }) })).data.invoice
    check(await tacConn.db.collection('invoiceFiles.files').countDocuments() === 2, 'second file')
    check((await A.req(`/purchase-invoices/${empty._id}`, { method: 'DELETE' })).status === 200, 'delete empty invoice')
    check(await tacConn.db.collection('invoiceFiles.files').countDocuments() === 1, 'file of deleted invoice kept')
  })
  await test('Invoice list: search, dealer filter, date range, status, pagination', async () => {
    const byNumber = await A.req('/purchase-invoices?search=inv-1025')
    check(byNumber.data.total === 2, `search ${byNumber.data.total}`)
    const byDealer = await A.req(`/purchase-invoices?dealer=${otherDealer._id}`)
    check(byDealer.data.items.every((i) => i.dealer === otherDealer._id) && byDealer.data.total === 3, `dealer ${byDealer.data.total}`)
    const byDate = await A.req('/purchase-invoices?from=2026-11-07&to=2026-11-07')
    check(byDate.data.total === 1, `date ${byDate.data.total}`)
    const completed = await A.req('/purchase-invoices?status=completed')
    check(completed.data.items.every((i) => i.status === 'Completed') && completed.data.total === 2, `completed ${completed.data.total}`)
    const paged = await A.req('/purchase-invoices?limit=2&page=2')
    check(paged.data.items.length === 2 && paged.data.pages === 3, `paging ${paged.data.items.length}/${paged.data.pages}`)
  })

  // ---------------- TAC downtime ----------------
  await test('19. TAC cluster down: API starts; inventory and sales work; lookup and files degrade cleanly', async () => {
    await startServer(5092, { TAC_MONGODB_URI: 'mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=1500&connectTimeoutMS=1500' })
    const D = client(5092); D.token = A.token
    const health = await D.req('/health')
    check(health.status === 200 && health.data.databases.main === 'connected' && health.data.databases.tac !== 'connected', JSON.stringify(health.data))
    await D.req('/financial/verify', { method: 'POST', body: { pin: PIN } })
    const plain = await D.req('/inventory', { method: 'POST', body: { brand: 'Vivo', model: 'Y29', imei1: imei(), purchasePrice: 9000, purchaseDate: '2026-11-08' } })
    check(plain.status === 201, `stock without invoice -> ${plain.status} ${plain.text}`)
    const withInvoice = await D.req('/inventory', { method: 'POST', body: { brand: 'Samsung', model: 'Galaxy A56 5G', imei1: imei(), purchasePrice: 5000, purchaseInvoiceId: inv._id } })
    check(withInvoice.status === 201, `stock with invoice -> ${withInvoice.status}`)
    const sale = await D.req('/sales', { method: 'POST', body: { imei: plain.data.item.imei1, sellingPrice: 11000 } })
    check(sale.status === 201, `sale -> ${sale.status}`)
    check((await D.req('/purchase-invoices')).status === 200, 'invoice list needs only main')
    const lookup = await D.req('/device-lookup', { method: 'POST', body: { imei: plain.data.item.imei1 } })
    check([503, 404].includes(lookup.status) && lookup.data.source === 'manual_entry' && lookup.data.localDatabaseAvailable === false, `lookup ${lookup.status} ${lookup.text}`)
    const file = await D.req(`/purchase-invoices/${inv._id}/attachment`)
    check(file.status === 503, `attachment -> ${file.status}`)
    check((await D.req('/device-lookup/import/status')).status === 503, 'import status')
  })

  // ---------------- IMEI lookup / HiCellTek ----------------
  if (process.argv.includes('--live-hicelltek')) {
    await test('20. Live HiCellTek fallback for an incomplete local TAC (uses 1 lookup)', async () => {
      await startServer(5094, { TAC_MONGODB_DB: REAL_TAC_DB, HICELLTEK_API_KEY: process.env.HICELLTEK_API_KEY })
      const H = client(5094); H.token = A.token
      await waitFor(async () => (await H.req('/health')).data?.databases?.tac === 'connected')
      const v = `35653069123456`; const r = await H.req('/device-lookup', { method: 'POST', body: { imei: v + luhn(v) } })
      check(r.status === 200 && r.data.source === 'hicelltek_api' && r.data.data.brandName === 'Samsung', `${r.status} ${r.text}`)
    })
  }
} catch (error) {
  results.push({ name: 'test harness', status: 'FAIL', detail: error.message.slice(0, 600) })
} finally {
  // Wait for the servers to exit so no in-flight write re-creates the temporary database after the drop.
  await Promise.all(servers.map((child) => (child.exitCode !== null ? null : new Promise((resolve) => { child.once('exit', resolve); child.kill() }))))
  for (const [conn, name] of [[mainConn, MAIN_DB], [tacConn, TAC_DB]]) {
    if (conn?.db?.databaseName === name && /_invtest_\d+$/.test(name)) await conn.db.dropDatabase().catch((e) => console.error(`drop ${name}: ${e.message}`))
    await conn?.close()
  }
}
for (const r of results) console.info(`${r.status}  ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`)
const failed = results.filter((r) => r.status === 'FAIL').length
console.info(`\n${results.length - failed}/${results.length} passed (temporary databases ${MAIN_DB} and ${TAC_DB} dropped)`)
process.exitCode = failed ? 1 : 0
