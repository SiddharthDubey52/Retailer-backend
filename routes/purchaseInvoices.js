// /api/purchase-invoices — dealer purchase invoices (stock inward).
// Quantities are visible to every signed-in user; amounts and the attachment (which shows prices)
// need financial access once a Financial PIN is set.
import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { Dealer, Inventory, PurchaseInvoice, normalizeInvoiceNumber } from '../models/index.js'
import { financialAccess, LOCKED_RESPONSE, redactInventory, requireFinancialAccess } from '../services/financialAccess.js'
import { deleteInvoiceFile, handleInvoiceUpload, storeInvoiceFile, streamInvoiceFile } from '../services/invoiceStorage.js'
import { inTransaction, invoiceStatus, serializeInvoice, statusFilter } from '../services/purchaseInvoiceService.js'
import { pagination, writeAudit } from '../utils.js'

const router = Router()
const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid id')
const money = z.coerce.number().finite().min(0).max(1e10)
const quantity = z.coerce.number().int('Quantity must be a whole number.').min(1).max(100000)
const createSchema = z.object({
  dealer: objectId,
  invoiceNumber: z.string().trim().min(1).max(80),
  invoiceDate: z.coerce.date().refine((d) => !Number.isNaN(d.getTime()), 'Invalid date'),
  totalPurchaseAmount: money,
  totalQuantity: quantity,
  brand: z.string().trim().max(80).optional().default(''),
  notes: z.string().trim().max(1000).optional().default(''),
})
const updateSchema = createSchema.partial().extend({ removeAttachment: z.union([z.boolean(), z.enum(['true', 'false'])]).optional() })
const conflict = (invoiceNumber) => ({ code: 'DUPLICATE_INVOICE', message: `Invoice ${invoiceNumber} already exists for this dealer.` })
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const isOwnedBy = (dealer) => dealer && !dealer.archivedAt

function dateRange(query) {
  if (!query.from && !query.to) return null
  return {
    ...(query.from && { $gte: new Date(query.from) }),
    ...(query.to && { $lte: new Date(`${query.to}T23:59:59.999`) }),
  }
}

// ---- List ----
router.get('/', async (request, response, next) => {
  try {
    const { page, limit, skip } = pagination(request)
    const filter = { ...statusFilter(String(request.query.status || '')) }
    const search = normalizeInvoiceNumber(request.query.search || '')
    if (search) filter.invoiceNumberKey = { $regex: escapeRegex(search) }
    if (request.query.dealer && mongoose.isValidObjectId(request.query.dealer)) filter.dealer = request.query.dealer
    const range = dateRange(request.query)
    if (range) filter.invoiceDate = range
    const [items, total, { granted }] = await Promise.all([
      PurchaseInvoice.find(filter).sort({ invoiceDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      PurchaseInvoice.countDocuments(filter),
      financialAccess(request),
    ])
    response.json({ items: items.map((i) => serializeInvoice(i, granted)), financialLocked: !granted, page, limit, total, pages: Math.ceil(total / limit) })
  } catch (error) { next(error) }
})

// ---- Invoices that can still receive stock (for the Add Stock dropdown). No amounts. ----
router.get('/available-for-stock', async (request, response, next) => {
  try {
    const filter = { remainingQuantity: { $gt: 0 } }
    const search = normalizeInvoiceNumber(request.query.search || '')
    if (search) filter.invoiceNumberKey = { $regex: escapeRegex(search) }
    if (request.query.dealer && mongoose.isValidObjectId(request.query.dealer)) filter.dealer = request.query.dealer
    const items = await PurchaseInvoice.find(filter).sort({ invoiceDate: -1, createdAt: -1 }).limit(50)
      .select('dealer dealerName invoiceNumber invoiceDate totalQuantity addedQuantity remainingQuantity brand').lean()
    response.json({
      items: items.map((i) => ({
        _id: i._id, dealer: i.dealer, dealerName: i.dealerName, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate,
        brand: i.brand, totalQuantity: i.totalQuantity, addedQuantity: i.addedQuantity, remainingQuantity: i.remainingQuantity, status: invoiceStatus(i),
      })),
    })
  } catch (error) { next(error) }
})

// ---- Create (multipart/form-data with optional "invoiceFile", or JSON) ----
router.post('/', handleInvoiceUpload, async (request, response, next) => {
  let stored = null
  try {
    // Entering an invoice total is a protected financial action.
    if (!(await financialAccess(request)).granted) return response.status(403).json(LOCKED_RESPONSE)
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_INVOICE', message: 'Enter the dealer, invoice number, invoice date, total amount and total quantity.', issues: parsed.error.issues })
    const data = parsed.data
    const dealer = await Dealer.findById(data.dealer).select('name archivedAt').lean()
    if (!isOwnedBy(dealer)) return response.status(400).json({ code: 'INVALID_DEALER', message: 'Select an existing, active dealer.' })
    const key = normalizeInvoiceNumber(data.invoiceNumber)
    if (await PurchaseInvoice.exists({ dealer: dealer._id, invoiceNumberKey: key })) return response.status(409).json(conflict(data.invoiceNumber))

    const _id = new mongoose.Types.ObjectId()
    if (request.file) stored = await storeInvoiceFile(request.file, { invoiceId: _id, uploadedBy: request.user._id })
    const invoice = await PurchaseInvoice.create({
      _id, ...data, dealer: dealer._id, dealerName: dealer.name, addedQuantity: 0, remainingQuantity: data.totalQuantity,
      invoiceFile: stored, createdBy: request.user._id,
    })
    await writeAudit(request.user._id, 'PURCHASE_INVOICE_CREATED', 'PurchaseInvoice', invoice._id, { invoiceNumber: invoice.invoiceNumber, totalQuantity: invoice.totalQuantity })
    response.status(201).json({ invoice: serializeInvoice(invoice, true) })
  } catch (error) {
    if (stored) await deleteInvoiceFile(stored.fileId)
    if (error.code === 11000) return response.status(409).json(conflict(request.body?.invoiceNumber))
    next(error)
  }
})

// ---- Details ----
router.get('/:id', async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ message: 'Invoice not found.' })
    const invoice = await PurchaseInvoice.findById(request.params.id).lean()
    if (!invoice) return response.status(404).json({ message: 'Invoice not found.' })
    const [{ granted }, dealer, statusCounts, linkedCost] = await Promise.all([
      financialAccess(request),
      Dealer.findById(invoice.dealer).select('name phone address archivedAt').lean(),
      Inventory.aggregate([{ $match: { purchaseInvoiceId: invoice._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Inventory.aggregate([{ $match: { purchaseInvoiceId: invoice._id } }, { $group: { _id: null, total: { $sum: '$purchasePrice' } } }]),
    ])
    const byStatus = Object.fromEntries(statusCounts.map((s) => [s._id, s.count]))
    response.json({
      invoice: serializeInvoice(invoice, granted),
      dealer,
      linkedStock: { inStock: byStatus.IN_STOCK || 0, sold: byStatus.SOLD || 0 },
      // Sum of the individual phone purchase prices linked so far (kept separate from the invoice total).
      linkedPurchaseTotal: granted ? linkedCost[0]?.total || 0 : null,
      financialLocked: !granted,
    })
  } catch (error) { next(error) }
})

// ---- Phones linked to an invoice ----
router.get('/:id/stock', async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ message: 'Invoice not found.' })
    if (!(await PurchaseInvoice.exists({ _id: request.params.id }))) return response.status(404).json({ message: 'Invoice not found.' })
    const { page, limit, skip } = pagination(request)
    const filter = { purchaseInvoiceId: request.params.id }
    const [items, total, { granted }] = await Promise.all([
      Inventory.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .select('brand model modelNumber ram storage color imei1 imei2 purchasePrice status createdAt purchaseDate').lean(),
      Inventory.countDocuments(filter),
      financialAccess(request),
    ])
    response.json({ items: items.map((i) => redactInventory(i, granted)), financialLocked: !granted, page, limit, total, pages: Math.ceil(total / limit) })
  } catch (error) { next(error) }
})

// ---- Attachment (shows prices, so it needs financial access) ----
router.get('/:id/attachment', requireFinancialAccess, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ message: 'Invoice not found.' })
    const invoice = await PurchaseInvoice.findById(request.params.id).select('invoiceFile').lean()
    if (!invoice?.invoiceFile) return response.status(404).json({ code: 'NO_ATTACHMENT', message: 'This invoice has no attachment.' })
    await streamInvoiceFile(invoice.invoiceFile, response, { download: request.query.download === '1' })
  } catch (error) {
    if (response.headersSent) return response.destroy(error)
    if (error.status) return response.status(error.status).json({ code: error.code, message: error.message })
    next(error)
  }
})

// ---- Update (multipart or JSON). Quantity can never drop below the phones already linked. ----
router.put('/:id', handleInvoiceUpload, async (request, response, next) => {
  let stored = null
  try {
    if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ message: 'Invoice not found.' })
    const parsed = updateSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ code: 'INVALID_INVOICE', message: 'Check the invoice details.', issues: parsed.error.issues })
    const { removeAttachment, ...changes } = parsed.data
    const { granted } = await financialAccess(request)
    // Changing the amount or the attachment (which shows prices) is financial.
    if ((changes.totalPurchaseAmount !== undefined || request.file || removeAttachment) && !granted) return response.status(403).json(LOCKED_RESPONSE)
    let newDealer = null
    if (changes.dealer) {
      newDealer = await Dealer.findById(changes.dealer).select('name archivedAt').lean()
      if (!isOwnedBy(newDealer)) return response.status(400).json({ code: 'INVALID_DEALER', message: 'Select an existing, active dealer.' })
    }
    if (request.file) stored = await storeInvoiceFile(request.file, { invoiceId: request.params.id, uploadedBy: request.user._id })

    let previousFileId = null
    const updated = await inTransaction(async (session) => {
      const current = await PurchaseInvoice.findById(request.params.id).session(session)
      if (!current) throw Object.assign(new Error('Invoice not found.'), { status: 404 })
      const set = {}
      if (changes.invoiceNumber !== undefined) Object.assign(set, { invoiceNumber: changes.invoiceNumber, invoiceNumberKey: normalizeInvoiceNumber(changes.invoiceNumber) })
      for (const key of ['invoiceDate', 'totalPurchaseAmount', 'brand', 'notes']) if (changes[key] !== undefined) set[key] = changes[key]
      if (newDealer && String(newDealer._id) !== String(current.dealer)) {
        if (current.addedQuantity > 0) throw Object.assign(new Error('The dealer cannot be changed after phones have been added to this invoice.'), { status: 409, code: 'INVOICE_HAS_STOCK' })
        Object.assign(set, { dealer: newDealer._id, dealerName: newDealer.name })
      }
      if (changes.totalQuantity !== undefined) {
        if (changes.totalQuantity < current.addedQuantity) {
          throw Object.assign(new Error(`Total quantity cannot be less than the ${current.addedQuantity} phones already added.`), { status: 409, code: 'QUANTITY_BELOW_ADDED' })
        }
        Object.assign(set, { totalQuantity: changes.totalQuantity, remainingQuantity: changes.totalQuantity - current.addedQuantity })
      }
      if (stored || removeAttachment === true || removeAttachment === 'true') {
        previousFileId = current.invoiceFile?.fileId || null
        set.invoiceFile = stored || null
      }
      // The write is conditional on the quantity we validated against, so a concurrent stock entry
      // forces a retry instead of producing a total below the linked count.
      const result = await PurchaseInvoice.findOneAndUpdate({ _id: current._id, addedQuantity: current.addedQuantity }, { $set: set }, { new: true, session, runValidators: true })
      if (!result) throw Object.assign(new Error('The invoice changed while saving. Please try again.'), { status: 409, code: 'WRITE_CONFLICT' })
      // Keep the snapshots on linked stock in sync with the invoice (the invoice is the source of truth).
      const snapshot = {}
      if (set.invoiceNumber !== undefined) snapshot.invoiceNumber = set.invoiceNumber
      if (set.invoiceDate !== undefined) snapshot.purchaseDate = set.invoiceDate
      if (Object.keys(snapshot).length && current.addedQuantity > 0) await Inventory.updateMany({ purchaseInvoiceId: current._id }, { $set: snapshot }, { session })
      await writeAudit(request.user._id, 'PURCHASE_INVOICE_UPDATED', 'PurchaseInvoice', current._id, { fields: Object.keys(set) }, session)
      return result
    })
    if (previousFileId) await deleteInvoiceFile(previousFileId)
    response.json({ invoice: serializeInvoice(updated, granted) })
  } catch (error) {
    if (stored) await deleteInvoiceFile(stored.fileId)
    if (error.code === 11000) return response.status(409).json(conflict(request.body?.invoiceNumber))
    if (error.status && error.status < 500) return response.status(error.status).json({ code: error.code, message: error.message })
    next(error)
  }
})

// ---- Delete: only while no phones are linked ----
router.delete('/:id', async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ message: 'Invoice not found.' })
    const invoice = await PurchaseInvoice.findById(request.params.id).select('invoiceNumber addedQuantity invoiceFile').lean()
    if (!invoice) return response.status(404).json({ message: 'Invoice not found.' })
    const linked = await Inventory.countDocuments({ purchaseInvoiceId: invoice._id })
    if (invoice.addedQuantity > 0 || linked > 0) {
      return response.status(409).json({ code: 'INVOICE_HAS_STOCK', message: `Invoice ${invoice.invoiceNumber} has ${Math.max(linked, invoice.addedQuantity)} linked phones and cannot be deleted.` })
    }
    const result = await PurchaseInvoice.deleteOne({ _id: invoice._id, addedQuantity: 0 })
    if (!result.deletedCount) return response.status(409).json({ code: 'INVOICE_HAS_STOCK', message: 'Phones were added to this invoice meanwhile; it was not deleted.' })
    if (invoice.invoiceFile) await deleteInvoiceFile(invoice.invoiceFile.fileId)
    await writeAudit(request.user._id, 'PURCHASE_INVOICE_DELETED', 'PurchaseInvoice', invoice._id, { invoiceNumber: invoice.invoiceNumber })
    response.json({ message: `Invoice ${invoice.invoiceNumber} deleted.` })
  } catch (error) { next(error) }
})

export default router
