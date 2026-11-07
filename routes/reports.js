import { Router } from 'express'
import { Inventory, Sale } from '../models/index.js'
import { pagination } from '../utils.js'

const router = Router()

router.get('/export.csv', async (request, response, next) => {
  try {
    const filter = {}
    if (request.query.from || request.query.to) filter.soldAt = {
      ...(request.query.from && { $gte: new Date(request.query.from) }),
      ...(request.query.to && { $lte: new Date(`${request.query.to}T23:59:59.999`) }),
    }
    const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
    response.setHeader('Content-Type', 'text/csv; charset=utf-8')
    response.setHeader('Content-Disposition', 'attachment; filename="Shabana Inventory-profit-report.csv"')
    response.write('Brand,Model,IMEI,Purchase price,Selling price,Discount,Additional expenses,Gross profit,Net profit,Sale date\n')
    const cursor = Sale.find(filter).sort({ soldAt: -1 }).select('snapshot purchasePrice sellingPrice discount additionalExpenses grossProfit netProfit soldAt').cursor()
    for await (const sale of cursor) {
      const row = [sale.snapshot.brand, sale.snapshot.model, sale.snapshot.imei1, sale.purchasePrice, sale.sellingPrice, sale.discount, sale.additionalExpenses, sale.grossProfit, sale.netProfit, sale.soldAt].map(escape).join(',')
      if (!response.write(`${row}\n`)) await new Promise((resolve) => response.once('drain', resolve))
    }
    response.end()
  } catch (error) { next(error) }
})

router.get('/', async (request, response, next) => {
  try {
    const filter = {}
    if (request.query.from || request.query.to) filter.soldAt = {
      ...(request.query.from && { $gte: new Date(request.query.from) }),
      ...(request.query.to && { $lte: new Date(`${request.query.to}T23:59:59.999`) }),
    }
    const purchaseFilter = {}
    if (request.query.from || request.query.to) purchaseFilter.purchaseDate = {
      ...(request.query.from && { $gte: new Date(request.query.from) }),
      ...(request.query.to && { $lte: new Date(`${request.query.to}T23:59:59.999`) }),
    }
    const { page, limit, skip } = pagination(request)
    const [summary, items, total, company, model, daily, monthly, dealerPurchases, inventoryInvestment] = await Promise.all([
      Sale.aggregate([{ $match: filter }, { $group: { _id: null, soldCount: { $sum: 1 }, purchaseAmount: { $sum: '$purchasePrice' }, salesRevenue: { $sum: '$sellingPrice' }, grossProfit: { $sum: '$grossProfit' }, netProfit: { $sum: '$netProfit' } } }]),
      Sale.find(filter).sort({ soldAt: -1 }).skip(skip).limit(limit),
      Sale.countDocuments(filter),
      Sale.aggregate([{ $match: filter }, { $group: { _id: '$snapshot.brand', soldCount: { $sum: 1 }, revenue: { $sum: '$sellingPrice' }, netProfit: { $sum: '$netProfit' } } }, { $sort: { netProfit: -1 } }]),
      Sale.aggregate([{ $match: filter }, { $group: { _id: { brand: '$snapshot.brand', model: '$snapshot.model' }, soldCount: { $sum: 1 }, netProfit: { $sum: '$netProfit' } } }, { $sort: { netProfit: -1 } }]),
      Sale.aggregate([{ $match: filter }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$soldAt' } }, salesRevenue: { $sum: '$sellingPrice' }, grossProfit: { $sum: '$grossProfit' }, netProfit: { $sum: '$netProfit' } } }, { $sort: { _id: 1 } }]),
      Sale.aggregate([{ $match: filter }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$soldAt' } }, salesRevenue: { $sum: '$sellingPrice' }, grossProfit: { $sum: '$grossProfit' }, netProfit: { $sum: '$netProfit' } } }, { $sort: { _id: 1 } }]),
      Inventory.aggregate([{ $match: purchaseFilter }, { $group: { _id: '$dealer', dealerName: { $first: '$dealerName' }, purchaseCount: { $sum: 1 }, purchaseAmount: { $sum: '$purchasePrice' } } }, { $sort: { purchaseAmount: -1 } }]),
      Inventory.aggregate([{ $match: { status: 'IN_STOCK' } }, { $group: { _id: null, amount: { $sum: '$purchasePrice' }, count: { $sum: 1 } } }]),
    ])
    response.json({ summary: summary[0] || { soldCount: 0, purchaseAmount: 0, salesRevenue: 0, grossProfit: 0, netProfit: 0 }, items, total, pages: Math.ceil(total / limit), company, model, daily, monthly, dealerPurchases, inventoryInvestment: inventoryInvestment[0] || { amount: 0, count: 0 }, page, limit })
  } catch (error) { next(error) }
})

export default router