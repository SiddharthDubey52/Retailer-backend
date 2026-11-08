import 'dotenv/config'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/database.js'
import { AuditLog, Dealer, DeviceModel, Expense, Inventory, Sale, User } from '../models/index.js'
import { isValidImei } from '../validation.js'

const apiBase = process.env.SMOKE_API_URL || `http://127.0.0.1:${process.env.PORT || 5000}/api`
const username = `smoke_${Date.now()}`
const password = crypto.randomBytes(24).toString('base64url')
const dealerName = `Smoke Dealer ${Date.now()}`
const brandName = `Smoke Brand ${Date.now()}`
const modelName = 'Temporary Test Phone'
let userId
let createdUser = false
let dealerId
let inventoryId
let saleId
let imei
let lookupImei
let identifiedInventoryId
let createdIdentifiedModel = false
let identifiedModel
const results = []
const testStartedAt = new Date()

function record(name, passed, detail = '') {
  results.push({ name, status: passed ? 'PASS' : 'FAIL', ...(detail && { detail }) })
  if (!passed) throw new Error(`${name} failed${detail ? `: ${detail}` : ''}`)
}

function skip(name, detail) {
  results.push({ name, status: 'SKIP', detail })
}

async function request(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(cookie && { Cookie: cookie }),
    },
    ...(body && { body: JSON.stringify(body) }),
  })
  const data = response.status === 204 ? null : await response.json().catch(() => null)
  return { response, data }
}

function makeValidImei(prefix = '') {
  const digits = `${prefix}${Array.from({ length: 14 - prefix.length }, () => crypto.randomInt(0, 10).toString()).join('')}`
  let sum = 0
  let doubleDigit = true
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index])
    if (doubleDigit) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    doubleDigit = !doubleDigit
  }
  return `${digits}${(10 - (sum % 10)) % 10}`
}

try {
  await connectDatabase()
  const existingUserCount = await User.countDocuments()
  const existingAdmin = existingUserCount ? await User.findOne({ role: 'ADMIN' }).select('_id username') : null
  if (existingUserCount && !existingAdmin) throw new Error('Users exist but no admin account is available for smoke tests.')

  const health = await request('/health')
  record('health endpoint', health.response.status === 200 && health.data?.status === 'ok')
  const setupStatus = await request('/auth/status')
  record('first-admin status', setupStatus.data?.setupRequired === (existingUserCount === 0))
  const unauthenticated = await request('/dashboard')
  record('protected route rejects unauthenticated requests', unauthenticated.response.status === 401)
  const anonymousLookup = await request('/device-lookup', { method: 'POST', body: { imei: '490154203237519' } })
  record('device lookup requires a session', anonymousLookup.response.status === 401)

  let cookie
  if (!existingUserCount) {
    const setup = await request('/auth/setup', {
      method: 'POST',
      body: { name: 'Temporary Smoke Admin', username, password, setupKey: process.env.SETUP_KEY },
    })
    record('admin setup', setup.response.status === 201, setup.data?.message || '')
    userId = setup.data.user.id
    createdUser = true
    const login = await request('/auth/login', { method: 'POST', body: { identifier: username, password } })
    record('username login', login.response.status === 200 && login.data?.user?.username === username)
    cookie = (login.response.headers.get('set-cookie') || '').split(';')[0]
    record('HttpOnly session cookie issued', cookie.startsWith('shop_session='))
  } else {
    userId = existingAdmin.id
    cookie = `shop_session=${jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '10m' })}`
    skip('admin setup/password login', 'Existing admin preserved; no password was requested from or exposed to the smoke test.')
  }
  const invalidLogin = await request('/auth/login', { method: 'POST', body: { identifier: existingAdmin?.username || username, password: 'wrong-password-123' } })
  record('invalid credentials rejected', invalidLogin.response.status === 401)
  const me = await request('/auth/me', { cookie })
  record('session authenticates /me', me.response.status === 200 && me.data?.user?.id === userId)

  const invalidLookup = await request('/device-lookup', { method: 'POST', body: { imei: '490154203237519' }, cookie })
  record('invalid IMEI rejected by lookup', invalidLookup.response.status === 400)
  // TAC 35073866 is complete in the local TACRecords collection, so no HiCellTek quota is used.
  lookupImei = makeValidImei('35073866')
  const localLookup = await request('/device-lookup', { method: 'POST', body: { imei: lookupImei }, cookie })
  const found = localLookup.data?.data
  record('local TAC lookup (complete record, no API call)', localLookup.response.status === 200 && localLookup.data?.source === 'local_database' && localLookup.data?.complete === true && Boolean(found?.brandName && found?.deviceName && found?.modelNumber), JSON.stringify(localLookup.data))
  // Stock entry, sales and reports need financial access once a Financial PIN is set.
  const finStatus = await request('/financial/status', { cookie })
  if (finStatus.data?.pinEnabled) {
    if (!process.env.SMOKE_FINANCIAL_PIN) {
      skip('stock-in, sales, profit, dealers, reports', 'A Financial PIN is set on this database. Set SMOKE_FINANCIAL_PIN to run these here, or run npm run test:financial / npm run test:invoices (isolated databases).')
      throw Object.assign(new Error('skip-rest'), { skipRest: true })
    }
    const unlock = await request('/financial/verify', { method: 'POST', body: { pin: process.env.SMOKE_FINANCIAL_PIN }, cookie })
    record('financial unlock with SMOKE_FINANCIAL_PIN', unlock.response.status === 200, `HTTP ${unlock.response.status}`)
    cookie = `${cookie}; ${(unlock.response.headers.get('set-cookie') || '').split(';')[0]}`
  }
  identifiedModel = { brand: found.brandName, model: found.deviceName, modelNumber: found.modelNumber }
  createdIdentifiedModel = !(await DeviceModel.exists(identifiedModel))
  const identifiedPurchase = await request('/inventory', {
    method: 'POST',
    body: { ...identifiedModel, imei1: lookupImei, ram: '8 GB', storage: '256 GB', color: 'Smoke Grey', purchaseDate: new Date().toISOString(), purchasePrice: 500, invoiceNumber: 'SMOKE-LOOKUP' },
    cookie,
  })
  identifiedInventoryId = identifiedPurchase.data?.item?._id
  record('stock-in after identification', identifiedPurchase.response.status === 201 && identifiedPurchase.data.item.brand === found.brandName && identifiedPurchase.data.item.modelNumber === found.modelNumber, `HTTP ${identifiedPurchase.response.status}`)
  const baselineDashboard = await request('/dashboard', { cookie })
  const baselineReport = await request('/reports?page=1&limit=1', { cookie })
  const baselineSales = await request('/sales?page=1&limit=1', { cookie })

  const dealer = await request('/dealers', { method: 'POST', body: { name: dealerName, phone: '5550100', address: 'Smoke test' }, cookie })
  record('dealer create', dealer.response.status === 201)
  dealerId = dealer.data.dealer._id
  const dealerUpdate = await request(`/dealers/${dealerId}`, { method: 'PATCH', body: { phone: '5550101' }, cookie })
  record('dealer update', dealerUpdate.response.status === 200 && dealerUpdate.data.dealer.phone === '5550101')

  imei = makeValidImei()
  record('valid test IMEI generated', isValidImei(imei))
  const purchaseBody = {
    brand: brandName,
    model: modelName,
    modelNumber: 'SMOKE-1',
    imei1: imei,
    purchaseDate: new Date().toISOString(),
    purchasePrice: 120,
    dealer: dealerId,
    dealerName,
    invoiceNumber: 'SMOKE-INVOICE',
  }
  const purchase = await request('/inventory', { method: 'POST', body: purchaseBody, cookie })
  record('inventory purchase create', purchase.response.status === 201)
  inventoryId = purchase.data.item._id
  const duplicateCheck = await request(`/inventory/check-imei?imei=${imei}`, { cookie })
  record('duplicate IMEI check', duplicateCheck.data?.exists === true)
  const invalidDuplicateCheck = await request('/inventory/check-imei?imei=490154203237519', { cookie })
  record('invalid IMEI rejected by duplicate check', invalidDuplicateCheck.response.status === 400)
  const duplicatePurchase = await request('/inventory', { method: 'POST', body: purchaseBody, cookie })
  record('duplicate purchase rejected', duplicatePurchase.response.status === 409)
  const inventorySearch = await request(`/inventory?search=${imei}&limit=5`, { cookie })
  record('inventory search', inventorySearch.data?.total === 1 && inventorySearch.data.items[0]._id === inventoryId)
  const inventoryUpdate = await request(`/inventory/${inventoryId}`, { method: 'PATCH', body: { purchasePrice: 125 }, cookie })
  record('inventory edit', inventoryUpdate.response.status === 200 && Number(inventoryUpdate.data?.item?.purchasePrice) === 125, `HTTP ${inventoryUpdate.response.status}; price=${inventoryUpdate.data?.item?.purchasePrice}; message=${inventoryUpdate.data?.message || ''}; details=${inventoryUpdate.data?.details || ''}`)

  const sale = await request('/sales', {
    method: 'POST',
    body: { imei, sellingPrice: 180, additionalExpenses: 15, customerName: 'Smoke Customer' },
    cookie,
  })
  record('sale create', sale.response.status === 201)
  saleId = sale.data.sale._id
  record('profit snapshot math', sale.data.sale.grossProfit === 55 && sale.data.sale.netProfit === 40)
  const secondSale = await request('/sales', { method: 'POST', body: { imei, sellingPrice: 180 }, cookie })
  record('double sale rejected', secondSale.response.status === 409)
  const availableSearch = await request(`/inventory?search=${imei}&limit=5`, { cookie })
  record('sold device removed from available stock', availableSearch.data?.total === 0)
  const soldSearch = await request(`/inventory?status=SOLD&search=${imei}&limit=5`, { cookie })
  record('sold device retained in inventory history', soldSearch.data?.total === 1)

  const sales = await request('/sales?page=1&limit=1', { cookie })
  record('sales pagination', sales.data?.total === baselineSales.data.total + 1)
  const dashboard = await request('/dashboard', { cookie })
  record('dashboard statistics', dashboard.response.status === 200 && dashboard.data.metrics.sold === baselineDashboard.data.metrics.sold + 1)
  const reports = await request('/reports?page=1&limit=1', { cookie })
  record('profit report', reports.data?.summary.netProfit === baselineReport.data.summary.netProfit + 40 && reports.data.total === baselineReport.data.total + 1)
  const csv = await fetch(`${apiBase}/reports/export.csv`, { headers: { Cookie: cookie } })
  const csvText = await csv.text()
  record('CSV export', csv.status === 200 && csvText.includes(imei))
  const dealerList = await request('/dealers', { cookie })
  record('dealer purchase totals', dealerList.data.items.some((item) => item._id === dealerId && item.totalPurchaseAmount === 125))
  const expenses = await Expense.countDocuments({ sale: saleId })
  record('sale expense persisted', expenses === 1)
  const saleDetail = await request(`/sales/${saleId}`, { cookie })
  record('sale detail snapshot', saleDetail.response.status === 200 && saleDetail.data.sale.purchasePrice === 125)

  const logout = await request('/auth/logout', { method: 'POST', cookie })
  record('logout endpoint', logout.response.status === 204)

  const dealerDelete = await request(`/dealers/${dealerId}`, { method: 'DELETE', cookie })
  record('dealer with history archived', dealerDelete.response.status === 200)
} catch (error) {
  if (!error.skipRest) {
    console.error(error.message)
    process.exitCode = 1
  }
} finally {
  if (saleId) {
    await Expense.deleteMany({ sale: saleId }).catch(() => {})
    await Sale.deleteOne({ _id: saleId }).catch(() => {})
  }
  if (inventoryId) await Inventory.deleteOne({ _id: inventoryId }).catch(() => {})
  if (identifiedInventoryId) await Inventory.deleteOne({ _id: identifiedInventoryId }).catch(() => {})
  if (lookupImei) await AuditLog.deleteMany({ 'changes.imei1': lookupImei }).catch(() => {})
  if (createdIdentifiedModel && identifiedModel) {
    const stillUsed = await Inventory.exists({ brand: identifiedModel.brand, model: identifiedModel.model, modelNumber: identifiedModel.modelNumber }).catch(() => true)
    if (!stillUsed) await DeviceModel.deleteMany({ ...identifiedModel, createdAt: { $gte: testStartedAt } }).catch(() => {})
  }
  if (dealerId) await Dealer.deleteOne({ _id: dealerId }).catch(() => {})
  if (userId) await AuditLog.deleteMany({ actor: userId, createdAt: { $gte: testStartedAt } }).catch(() => {})
  if (createdUser && userId) await User.deleteOne({ _id: userId }).catch(() => {})
  if (imei) await AuditLog.deleteMany({ 'changes.imei1': imei }).catch(() => {})
  if (brandName) await DeviceModel.deleteMany({ brand: brandName }).catch(() => {})
  await mongoose.disconnect().catch(() => {})
  console.info(JSON.stringify(results, null, 2))
}