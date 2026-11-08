import { Router } from 'express'
import { z } from 'zod'
import { Dealer, Inventory, PurchaseInvoice } from '../models/index.js'
import { financialAccess } from '../services/financialAccess.js'
import { writeAudit } from '../utils.js'

const router = Router()
const dealerSchema = z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().max(30).optional().default(''), address: z.string().trim().max(300).optional().default('') })

router.get('/', async (request, response, next) => {
  try {
    const dealers = await Dealer.aggregate([
      { $match: { archivedAt: null } },
      { $lookup: { from: 'inventories', localField: '_id', foreignField: 'dealer', as: 'purchases' } },
      { $addFields: { purchaseCount: { $size: '$purchases' }, totalPurchaseAmount: { $sum: '$purchases.purchasePrice' }, stockCount: { $size: { $filter: { input: '$purchases', as: 'item', cond: { $eq: ['$$item.status', 'IN_STOCK'] } } } } } },
      { $project: { purchases: 0 } },
      { $sort: { name: 1 } },
    ])
    const { granted } = await financialAccess(request)
    response.json({ items: granted ? dealers : dealers.map((dealer) => ({ ...dealer, totalPurchaseAmount: null })), financialLocked: !granted })
  } catch (error) { next(error) }
})

router.post('/', async (request, response, next) => {
  try {
    const parsed = dealerSchema.safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Enter a dealer name.', issues: parsed.error.issues })
    const dealer = await Dealer.create(parsed.data)
    await writeAudit(request.user.id, 'DEALER_CREATED', 'Dealer', dealer.id, parsed.data)
    response.status(201).json({ dealer })
  } catch (error) { next(error) }
})

router.patch('/:id', async (request, response, next) => {
  try {
    const parsed = dealerSchema.partial().safeParse(request.body)
    if (!parsed.success) return response.status(400).json({ message: 'Check the dealer details.', issues: parsed.error.issues })
    const dealer = await Dealer.findOneAndUpdate({ _id: request.params.id, archivedAt: null }, { $set: parsed.data }, { new: true, runValidators: true })
    if (!dealer) return response.status(404).json({ message: 'Dealer not found.' })
    await Inventory.updateMany({ dealer: dealer.id }, { $set: { dealerName: dealer.name } })
    await PurchaseInvoice.updateMany({ dealer: dealer.id }, { $set: { dealerName: dealer.name } })
    await writeAudit(request.user.id, 'DEALER_UPDATED', 'Dealer', dealer.id, parsed.data)
    response.json({ dealer })
  } catch (error) { next(error) }
})

router.delete('/:id', async (request, response, next) => {
  try {
    const dealer = await Dealer.findById(request.params.id)
    if (!dealer || dealer.archivedAt) return response.status(404).json({ message: 'Dealer not found.' })
    const hasPurchases = await Inventory.exists({ dealer: dealer.id }) || await PurchaseInvoice.exists({ dealer: dealer.id })
    if (hasPurchases) dealer.archivedAt = new Date()
    else await dealer.deleteOne()
    if (hasPurchases) await dealer.save()
    await writeAudit(request.user.id, hasPurchases ? 'DEALER_ARCHIVED' : 'DEALER_DELETED', 'Dealer', dealer.id, {})
    response.json({ message: hasPurchases ? 'Dealer archived because purchase history exists.' : 'Dealer deleted.' })
  } catch (error) { next(error) }
})

export default router