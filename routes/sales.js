import { Router } from 'express'
import mongoose from 'mongoose'
import { z } from 'zod'
import { Expense, Inventory, Sale } from '../models/index.js'
import { financialAccess, redactSale, requireFinancialAccess } from '../services/financialAccess.js'
import { inTransaction } from '../services/purchaseInvoiceService.js'
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
const saleUpdateSchema = z.object({
  sellingPrice: z.coerce.number().positive().optional(),
  discount: z.coerce.number().min(0).optional(),
  additionalExpenses: z.coerce.number().min(0).optional(),
  customerName: z.string().trim().max(120).optional(),
  customerPhone: z.string().trim().max(30).optional(),
})
const notFound = () => Object.assign(new Error('Sale not found.'), { status: 404 })

router.get('/', async (request, response, next) => {
  try {
    const { page, limit, skip } = pagination(request)
    const query = {}
    if (request.query.from || request.query.to) query.soldAt = {
      ...(request.query.from && { $gte: new Date(request.query.from) }),
      ...(request.query.to && { $lte: new Date(`${request.query.to}T23:59:59.999`) }),
    }
    const [items, total, { granted }] = await Promise.all([Sale.find(query).sort({ soldAt: -1 }).skip(skip).limit(limit), Sale.countDocuments(query), financialAccess(request)])
    response.json({ items: items.map((sale) => redactSale(sale, granted)), financialLocked: !granted, page, limit, total, pages: Math.ceil(total / limit) })
  } catch (error) { next(error) }
})

router.get('/:id', async (request, response, next) => {
  try {
    const sale = await Sale.findById(request.params.id)
    if (!sale) return response.status(404).json({ message: 'Sale not found.' })
    const { granted } = await financialAccess(request)
    response.json({ sale: redactSale(sale, granted), financialLocked: !granted })
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
    // Profit is always computed on the server; it is only returned when financial access is granted.
    const { granted } = await financialAccess(request)
    response.status(201).json({ sale: redactSale(createdSale, granted), financialLocked: !granted })
  } catch (error) { next(error) }
  finally { await session.endSession() }
})

// Corrects a recorded sale. Profit is recalculated here; purchase price and the phone itself never change.
router.patch('/:id', requireFinancialAccess, async (request, response, next) => {
  try {
    const parsed = saleUpdateSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Enter a valid selling price and amounts.', issues: parsed.error.issues })
    const { customerName, customerPhone, ...amounts } = parsed.data
    const saved = await inTransaction(async (session) => {
      const sale = await Sale.findById(request.params.id).session(session)
      if (!sale) throw notFound()
      Object.assign(sale, amounts)
      if (customerName !== undefined) sale.customer.name = customerName
      if (customerPhone !== undefined) sale.customer.phone = customerPhone
      sale.grossProfit = sale.sellingPrice - sale.purchasePrice
      sale.netProfit = sale.grossProfit - sale.additionalExpenses
      await sale.save({ session })
      if (amounts.additionalExpenses !== undefined) {
        await Expense.deleteMany({ sale: sale._id }, { session })
        if (amounts.additionalExpenses > 0) {
          await Expense.create([{ description: `Sale expense: ${sale.snapshot.brand} ${sale.snapshot.model}`, amount: amounts.additionalExpenses, sale: sale._id }], { session })
        }
      }
      await writeAudit(request.user.id, 'SALE_UPDATED', 'Sale', sale._id, parsed.data, session)
      return sale
    })
    response.json({ sale: redactSale(saved, true) })
  } catch (error) { next(error) }
})

// Deletes a sale and returns the phone to stock under the same record, so its IMEI stays taken.
router.delete('/:id', requireFinancialAccess, async (request, response, next) => {
  try {
    await inTransaction(async (session) => {
      const sale = await Sale.findByIdAndDelete(request.params.id, { session })
      if (!sale) throw notFound()
      const restored = await Inventory.findOneAndUpdate({ _id: sale.inventory, status: 'SOLD' }, { $set: { status: 'IN_STOCK' } }, { session })
      if (!restored) throw Object.assign(new Error('The phone for this sale could not be returned to stock.'), { status: 409 })
      await Expense.deleteMany({ sale: sale._id }, { session })
      await writeAudit(request.user.id, 'SALE_DELETED', 'Sale', sale._id, { inventory: sale.inventory, sellingPrice: sale.sellingPrice, imei1: sale.snapshot?.imei1 }, session)
    })
    response.json({ message: 'Sale deleted. The phone is back in stock.' })
  } catch (error) { next(error) }
})

export default router