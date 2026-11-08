import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { Dealer, DeviceModel, Inventory } from '../models/index.js'
import { inTransaction, releaseInvoiceSlot, reserveInvoiceSlot, stockFieldsFromInvoice } from '../services/purchaseInvoiceService.js'
import { financialAccess, LOCKED_RESPONSE, redactInventory } from '../services/financialAccess.js'
import { pagination, writeAudit } from '../utils.js'
import { isValidImei } from '../validation.js'

const router = Router()
const deviceSchema = z.object({
  brand: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(120),
  modelNumber: z.string().trim().max(80).optional().default(''),
  ram: z.string().trim().max(30).optional().default(''),
  storage: z.string().trim().max(30).optional().default(''),
  color: z.string().trim().max(50).optional().default(''),
  imei1: z.string().refine(isValidImei, 'Enter a valid 15-digit IMEI.'),
  imei2: z.union([z.string().refine(isValidImei), z.literal('')]).optional().default(''),
  serialNumber: z.string().trim().max(60).optional().default(''),
  dealer: z.string().optional().default(''),
  dealerName: z.string().trim().max(120).optional().default(''),
  invoiceNumber: z.string().trim().max(80).optional().default(''),
  // Required unless a purchase invoice is selected (then the invoice date is used).
  purchaseDate: z.coerce.date().optional(),
  purchasePrice: z.coerce.number().min(0),
  purchaseInvoiceId: z.union([z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid invoice'), z.literal(''), z.null()]).optional(),
})
const deviceUpdateSchema = z.object({
  brand: z.string().trim().min(1).max(80).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  modelNumber: z.string().trim().max(80).optional(),
  ram: z.string().trim().max(30).optional(),
  storage: z.string().trim().max(30).optional(),
  color: z.string().trim().max(50).optional(),
  imei1: z.string().refine(isValidImei).optional(),
  imei2: z.union([z.string().refine(isValidImei), z.literal('')]).optional(),
  serialNumber: z.string().trim().max(60).optional(),
  dealer: z.string().optional(),
  dealerName: z.string().trim().max(120).optional(),
  invoiceNumber: z.string().trim().max(80).optional(),
  purchaseDate: z.coerce.date().optional(),
  purchasePrice: z.coerce.number().min(0).optional(),
  // Move to another invoice, or null to unlink.
  purchaseInvoiceId: z.union([z.string().refine((v) => mongoose.isValidObjectId(v), 'Invalid invoice'), z.null()]).optional(),
})
const INVOICE_MANAGED = ['dealer', 'dealerName', 'invoiceNumber', 'purchaseDate']
const sendKnown = (response, error) => response.status(error.status).json({ code: error.code, message: error.message })

router.get('/', async (request, response, next) => {
  try {
    const { page, limit, skip } = pagination(request)
    const query = { status: request.query.status === 'SOLD' ? 'SOLD' : 'IN_STOCK' }
    const search = String(request.query.search || '').trim()
    if (search) query.$or = [
      { imeiKeys: search.replace(/\D/g, '') },
      { brand: { $regex: search, $options: 'i' } },
      { model: { $regex: search, $options: 'i' } },
      { modelNumber: { $regex: search, $options: 'i' } },
      { serialNumber: { $regex: search, $options: 'i' } },
      { dealerName: { $regex: search, $options: 'i' } },
    ]
    if (request.query.ram) query.ram = request.query.ram
    if (request.query.storage) query.storage = request.query.storage
    if (request.query.from || request.query.to) query.purchaseDate = {
      ...(request.query.from && { $gte: new Date(request.query.from) }),
      ...(request.query.to && { $lte: new Date(`${request.query.to}T23:59:59.999`) }),
    }
    const { granted } = await financialAccess(request)
    const sortOptions = {
      newest: { createdAt: -1 },
      oldest: { purchaseDate: 1 },
      // Sorting by cost would leak price order, so it needs financial access.
      ...(granted && { priceAsc: { purchasePrice: 1 }, priceDesc: { purchasePrice: -1 } }),
    }
    const [items, total] = await Promise.all([
      Inventory.find(query).sort(sortOptions[request.query.sort] || sortOptions.newest).skip(skip).limit(limit),
      Inventory.countDocuments(query),
    ])
    response.json({ items: items.map((item) => redactInventory(item, granted)), financialLocked: !granted, page, limit, total, pages: Math.ceil(total / limit) })
  } catch (error) { next(error) }
})

router.get('/check-imei', async (request, response, next) => {
  try {
    const imei = String(request.query.imei || '').replace(/\D/g, '')
    if (!isValidImei(imei)) return response.status(400).json({ message: 'Enter a valid 15-digit IMEI.' })
    response.json({ exists: Boolean(await Inventory.exists({ imeiKeys: imei })) })
  } catch (error) { next(error) }
})

// Quick stock-out: available phones whose IMEI 1 or IMEI 2 ends with these 6 digits.
// Returns every match (never auto-selects) and no cost information.
router.get('/search-imei-last-six', async (request, response, next) => {
  try {
    const digits = String(request.query.digits ?? '')
    if (!/^\d{6}$/.test(digits)) return response.status(400).json({ message: 'Enter exactly 6 digits (numbers only).' })
    const limit = 25
    const found = await Inventory.find({ imeiLastSix: digits, status: 'IN_STOCK' })
      .sort({ purchaseDate: 1 })
      .limit(limit + 1)
      .select('brand model modelNumber ram storage color imei1 imei2 invoiceNumber dealerName status purchaseDate')
      .lean()
    const items = found.slice(0, limit).map((item) => ({
      ...item,
      matchedImei: [item.imei1, item.imei2].find((imei) => imei?.endsWith(digits)) || item.imei1,
      imeiLastSix: digits,
    }))
    response.json({
      digits,
      items,
      total: items.length,
      truncated: found.length > limit,
      ...(items.length === 0 && { message: 'No available phone found with these IMEI last 6 digits.' }),
    })
  } catch (error) { next(error) }
})

router.get('/:id', async (request, response, next) => {
  try {
    const item = await Inventory.findById(request.params.id)
    if (!item) return response.status(404).json({ message: 'Mobile not found.' })
    const { granted } = await financialAccess(request)
    response.json({ item: redactInventory(item, granted), financialLocked: !granted })
  } catch (error) { next(error) }
})

router.post('/', async (request, response, next) => {
  try {
    const parsed = deviceSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Check the mobile details and enter a valid 15-digit IMEI.', issues: parsed.error.issues })
    const { purchaseInvoiceId, ...data } = parsed.data
    // Entering a purchase price is a protected financial action.
    if (!(await financialAccess(request)).granted) return response.status(403).json(LOCKED_RESPONSE)
    if (!purchaseInvoiceId && !data.purchaseDate) return response.status(400).json({ message: 'Enter the purchase date or select a purchase invoice.' })
    const imeiKeys = [...new Set([data.imei1, data.imei2].filter(Boolean))]
    const duplicate = await Inventory.findOne({ imeiKeys: { $in: imeiKeys } }).select('imei1 imei2')
    if (duplicate) return response.status(409).json({ message: 'This IMEI is already recorded in inventory.' })
    let dealer = null
    if (!purchaseInvoiceId && data.dealer) {
      dealer = await Dealer.findById(data.dealer).select('name')
      if (!dealer) return response.status(400).json({ message: 'Selected dealer was not found.' })
    }

    // One transaction: take an invoice unit, then create the item. A duplicate IMEI (unique index)
    // or any other failure rolls the invoice count back, so counts never drift.
    const item = await inTransaction(async (session) => {
      const invoiceFields = purchaseInvoiceId ? stockFieldsFromInvoice(await reserveInvoiceSlot(purchaseInvoiceId, session)) : {}
      const model = await DeviceModel.findOneAndUpdate(
        { brand: data.brand, model: data.model, modelNumber: data.modelNumber },
        { $set: { ram: data.ram, storage: data.storage, color: data.color } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      )
      const [created] = await Inventory.create([{
        ...data,
        deviceModel: model.id,
        dealer: dealer?.id || null,
        dealerName: dealer?.name || data.dealerName,
        imeiKeys,
        ...invoiceFields, // the invoice is the source of truth for dealer, invoice number and date
      }], { session })
      await writeAudit(request.user.id, 'PURCHASE_CREATED', 'Inventory', created.id, { imei1: created.imei1, purchasePrice: created.purchasePrice, purchaseInvoiceId: created.purchaseInvoiceId }, session)
      return created
    })
    response.status(201).json({ item: redactInventory(item, true) })
  } catch (error) {
    if (error.status && error.status < 500) return sendKnown(response, error)
    next(error)
  }
})

router.patch('/:id', async (request, response, next) => {
  try {
    const current = await Inventory.findById(request.params.id)
    if (!current) return response.status(404).json({ message: 'Mobile not found.' })
    if (current.status !== 'IN_STOCK') return response.status(409).json({ message: 'Sold inventory cannot be edited.' })
    const parsed = deviceUpdateSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Check the mobile details.', issues: parsed.error.issues })
    const { purchaseInvoiceId, ...changes } = parsed.data
    const { granted } = await financialAccess(request)
    if (changes.purchasePrice !== undefined && !granted) return response.status(403).json(LOCKED_RESPONSE)
    const currentInvoice = current.purchaseInvoiceId ? String(current.purchaseInvoiceId) : null
    const invoiceChange = purchaseInvoiceId !== undefined && (purchaseInvoiceId || null) !== currentInvoice
    const targetInvoice = invoiceChange ? purchaseInvoiceId || null : currentInvoice
    // Dealer, invoice number and purchase date belong to the invoice while one is linked.
    if (targetInvoice && INVOICE_MANAGED.some((key) => changes[key] !== undefined)) {
      return response.status(409).json({ code: 'MANAGED_BY_INVOICE', message: 'Dealer, invoice number and purchase date come from the linked purchase invoice. Change the invoice instead.' })
    }
    if (changes.imei1 || changes.imei2 !== undefined) {
      changes.imei1 ??= current.imei1
      changes.imei2 ??= current.imei2
      const imeiKeys = [...new Set([changes.imei1, changes.imei2].filter(Boolean))]
      const duplicate = await Inventory.findOne({ _id: { $ne: current.id }, imeiKeys: { $in: imeiKeys } })
      if (duplicate) return response.status(409).json({ message: 'This IMEI is already recorded in inventory.' })
      changes.imeiKeys = imeiKeys
    }
    if (changes.dealer) {
      const dealer = await Dealer.findById(changes.dealer)
      if (!dealer) return response.status(400).json({ message: 'Selected dealer was not found.' })
      changes.dealerName = dealer.name
    }

    const saved = await inTransaction(async (session) => {
      const item = await Inventory.findOne({ _id: current._id, status: 'IN_STOCK' }).session(session)
      if (!item) throw Object.assign(new Error('This mobile was sold or removed meanwhile.'), { status: 409 })
      if (invoiceChange) {
        // Release the old invoice and take a unit from the new one in the same transaction.
        if (item.purchaseInvoiceId) await releaseInvoiceSlot(item.purchaseInvoiceId, session)
        if (targetInvoice) Object.assign(item, stockFieldsFromInvoice(await reserveInvoiceSlot(targetInvoice, session)))
        else item.purchaseInvoiceId = null // unlinked: dealer/invoice snapshots stay as historical values
      }
      Object.assign(item, changes)
      await item.save({ session })
      await writeAudit(request.user.id, 'INVENTORY_UPDATED', 'Inventory', item.id, { ...changes, ...(invoiceChange && { purchaseInvoiceId: targetInvoice }) }, session)
      return item
    })
    response.json({ item: redactInventory(saved, granted) })
  } catch (error) {
    if (error.status && error.status < 500) return sendKnown(response, error)
    next(error)
  }
})

// Removes an in-stock item (e.g. entered by mistake). Sold items keep their history and cannot be deleted.
// A linked invoice gets its unit back in the same transaction.
router.delete('/:id', async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.id)) return response.status(404).json({ message: 'Mobile not found.' })
    const removed = await inTransaction(async (session) => {
      const item = await Inventory.findOneAndDelete({ _id: request.params.id, status: 'IN_STOCK' }, { session })
      if (!item) {
        const exists = await Inventory.exists({ _id: request.params.id }).session(session)
        throw Object.assign(new Error(exists ? 'Sold mobiles cannot be deleted; they are part of sales history.' : 'Mobile not found.'), { status: exists ? 409 : 404 })
      }
      if (item.purchaseInvoiceId) await releaseInvoiceSlot(item.purchaseInvoiceId, session)
      await writeAudit(request.user.id, 'INVENTORY_DELETED', 'Inventory', item._id, { imei1: item.imei1, purchaseInvoiceId: item.purchaseInvoiceId }, session)
      return item
    })
    response.json({ message: 'Mobile removed from stock.', id: removed._id })
  } catch (error) {
    if (error.status && error.status < 500) return sendKnown(response, error)
    next(error)
  }
})

export default router