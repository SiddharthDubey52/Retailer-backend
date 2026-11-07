import { Router } from 'express'
import { Inventory, Sale } from '../models/index.js'

const router = Router()

router.get('/', async (_request, response, next) => {
  try {
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const [stock, sales, todaySales, brandMix, recent, daily, lowStock] = await Promise.all([
      Inventory.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, investment: { $sum: '$purchasePrice' } } }]),
      Sale.aggregate([{ $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$sellingPrice' }, gross: { $sum: '$grossProfit' }, net: { $sum: '$netProfit' } } }]),
      Sale.aggregate([{ $match: { soldAt: { $gte: startOfToday } } }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$sellingPrice' }, profit: { $sum: '$netProfit' } } }]),
      Inventory.aggregate([{ $match: { status: 'IN_STOCK' } }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 8 }]),
      Sale.find().sort({ soldAt: -1 }).limit(6).select('snapshot sellingPrice netProfit soldAt'),
      Sale.aggregate([{ $match: { soldAt: { $gte: new Date(Date.now() - 6 * 86400000) } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$soldAt' } }, sales: { $sum: '$sellingPrice' }, profit: { $sum: '$netProfit' } } }, { $sort: { _id: 1 } }]),
      Inventory.aggregate([{ $match: { status: 'IN_STOCK' } }, { $group: { _id: '$deviceModel', count: { $sum: 1 } } }, { $lookup: { from: 'devicemodels', localField: '_id', foreignField: '_id', as: 'model' } }, { $unwind: '$model' }, { $match: { $expr: { $lte: ['$count', '$model.lowStockThreshold'] } } }, { $project: { _id: 0, brand: '$model.brand', model: '$model.model', count: 1 } }, { $sort: { count: 1 } }]),
    ])
    const byStatus = Object.fromEntries(stock.map((row) => [row._id, row]))
    const total = sales[0] || { count: 0, revenue: 0, gross: 0, net: 0 }
    const today = todaySales[0] || { count: 0, revenue: 0, profit: 0 }
    response.json({
      metrics: {
        available: byStatus.IN_STOCK?.count || 0,
        sold: byStatus.SOLD?.count || 0,
        purchaseInvestment: byStatus.IN_STOCK?.investment || 0,
        totalPurchaseAmount: (byStatus.IN_STOCK?.investment || 0) + (byStatus.SOLD?.investment || 0),
        salesRevenue: total.revenue,
        grossProfit: total.gross,
        netProfit: total.net,
        todaySales: today.count,
        todayRevenue: today.revenue,
        todayProfit: today.profit,
        lowStock: lowStock.length,
      },
      charts: { daily, brandMix: brandMix.map(({ _id, count }) => ({ name: _id, value: count })) },
      lowStock,
      recent: recent.map((sale) => ({ id: sale.id, brand: sale.snapshot.brand, model: sale.snapshot.model, sellingPrice: sale.sellingPrice, netProfit: sale.netProfit, soldAt: sale.soldAt })),
    })
  } catch (error) { next(error) }
})

export default router