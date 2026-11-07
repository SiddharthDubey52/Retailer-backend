import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { Expense, Inventory, Sale } from '../models/index.js'
import { pagination, writeAudit } from '../utils.js'
import { isValidImei } from '../validation.js'

const router = Router()
const saleSchema = z.object({
  imei: z.string().refine(isValidImei, 'Enter a valid 15-digit IMEI.'),
  sellingPrice: z.coerce.number().positive(),
  discount: z.coerce.number().min(0).default(0),
  additionalExpenses: z.coerce.number().min(0).default(0),
  customerName: z.string().trim().max(120).optional().default(''),
  customerPhone: z.string().trim().max(30).optional().default(''),
})

router.get('/', async (request, response, next) => {
  try {
    const { page, limit, skip } = pagination(request)
    const query = {}
    if (request.query.from || request.query.to) query.soldAt = {
      ...(request.query.from && { $gte: new Date(request.query.from) }),
      ...(request.query.to && { $lte: new Date(`${request.query.to}T23:59:59.999`) }),
    }
    const [items, total] = await Promise.all([Sale.find(query).sort({ soldAt: -1 }).skip(skip).limit(limit), Sale.countDocuments(query)])
    response.json({ items, page, limit, total, pages: Math.ceil(total / limit) })
  } catch (error) { next(error) }
})

router.get('/:id', async (request, response, next) => {
  try {
    const sale = await Sale.findById(request.params.id)
    if (!sale) return response.status(404).json({ message: 'Sale not found.' })
    response.json({ sale })
  } catch (error) { next(error) }
})

router.post('/', async (request, response, next) => {
  const parsed = saleSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Enter a valid IMEI and selling price.', issues: parsed.error.issues })
  const data = parsed.data
  const session = await mongoose.startSession()
  let createdSale
  try {
    await session.withTransaction(async () => {
      const item = await Inventory.findOneAndUpdate(
        { imeiKeys: data.imei, status: 'IN_STOCK' },
        { $set: { status: 'SOLD' } },
        { new: true, session },
      )
      if (!item) {
        const alreadySold = await Inventory.exists({ imeiKeys: data.imei, status: 'SOLD' }).session(session)
        const error = new Error(alreadySold ? 'This mobile has already been sold.' : 'No in-stock mobile was found for this IMEI.')
        error.status = alreadySold ? 409 : 404
        throw error
      }
      const grossProfit = data.sellingPrice - item.purchasePrice
      const netProfit = grossProfit - data.additionalExpenses
      const [sale] = await Sale.create([{
        inventory: item.id,
        snapshot: item.toObject(),
        purchasePrice: item.purchasePrice,
        sellingPrice: data.sellingPrice,
        discount: data.discount,
        additionalExpenses: data.additionalExpenses,
        grossProfit,
        netProfit,
        customer: { name: data.customerName, phone: data.customerPhone },
      }], { session })
      if (data.additionalExpenses > 0) {
        await Expense.create([{ description: `Sale expense: ${item.brand} ${item.model}`, amount: data.additionalExpenses, sale: sale.id }], { session })
      }
      await writeAudit(request.user.id, 'MOBILE_SOLD', 'Inventory', item.id, { sale: sale.id, sellingPrice: data.sellingPrice }, session)
      createdSale = sale
    })
    response.status(201).json({ sale: createdSale })
  } catch (error) { next(error) }
  finally { await session.endSession() }
})

export default router