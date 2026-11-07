import { Router } from 'express'
import { z } from 'zod'
import { Dealer, DeviceModel, Inventory } from '../models/index.js'
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
  purchaseDate: z.coerce.date(),
  purchasePrice: z.coerce.number().min(0),
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
})

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
    const sortOptions = {
      newest: { createdAt: -1 },
      oldest: { purchaseDate: 1 },
      priceAsc: { purchasePrice: 1 },
      priceDesc: { purchasePrice: -1 },
    }
    const [items, total] = await Promise.all([
      Inventory.find(query).sort(sortOptions[request.query.sort] || sortOptions.newest).skip(skip).limit(limit),
      Inventory.countDocuments(query),
    ])
    response.json({ items, page, limit, total, pages: Math.ceil(total / limit) })
  } catch (error) { next(error) }
})

router.get('/check-imei', async (request, response, next) => {
  try {
    const imei = String(request.query.imei || '').replace(/\D/g, '')
    if (!isValidImei(imei)) return response.status(400).json({ message: 'Enter a valid 15-digit IMEI.' })
    response.json({ exists: Boolean(await Inventory.exists({ imeiKeys: imei })) })
  } catch (error) { next(error) }
})

router.get('/:id', async (request, response, next) => {
  try {
    const item = await Inventory.findById(request.params.id)
    if (!item) return response.status(404).json({ message: 'Mobile not found.' })
    response.json({ item })
  } catch (error) { next(error) }
})

router.post('/', async (request, response, next) => {
  try {
    const parsed = deviceSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Check the mobile details and enter a valid 15-digit IMEI.', issues: parsed.error.issues })
    const data = parsed.data
    const imeiKeys = [...new Set([data.imei1, data.imei2].filter(Boolean))]
    const duplicate = await Inventory.findOne({ imeiKeys: { $in: imeiKeys } }).select('imei1 imei2')
    if (duplicate) return response.status(409).json({ message: 'This IMEI is already recorded in inventory.' })
    const dealer = data.dealer && await Dealer.findById(data.dealer).select('name')
    if (data.dealer && !dealer) return response.status(400).json({ message: 'Selected dealer was not found.' })
    const model = await DeviceModel.findOneAndUpdate(
      { brand: data.brand, model: data.model, modelNumber: data.modelNumber },
      { $set: { ram: data.ram, storage: data.storage, color: data.color } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    const item = await Inventory.create({ ...data, deviceModel: model.id, dealer: dealer?.id || null, dealerName: dealer?.name || data.dealerName, imeiKeys })
    await writeAudit(request.user.id, 'PURCHASE_CREATED', 'Inventory', item.id, { imei1: item.imei1, purchasePrice: item.purchasePrice })
    response.status(201).json({ item })
  } catch (error) { next(error) }
})

router.patch('/:id', async (request, response, next) => {
  try {
    const current = await Inventory.findById(request.params.id)
    if (!current) return response.status(404).json({ message: 'Mobile not found.' })
    if (current.status !== 'IN_STOCK') return response.status(409).json({ message: 'Sold inventory cannot be edited.' })
    const parsed = deviceUpdateSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Check the mobile details.', issues: parsed.error.issues })
    const changes = parsed.data
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
    Object.assign(current, changes)
    await current.save()
    await writeAudit(request.user.id, 'INVENTORY_UPDATED', 'Inventory', current.id, changes)
    response.json({ item: current })
  } catch (error) { next(error) }
})

export default router