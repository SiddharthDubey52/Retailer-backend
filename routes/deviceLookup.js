import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.js'
import { TACImportLog, TACRecord } from '../models/index.js'
import { identifyDevice } from '../services/deviceLookup.js'
import { runTacImport } from '../services/tac/importer.js'
import { TAC_SOURCES } from '../services/tac/sources.js'

const router = Router()

// POST /api/device-lookup  { imei } -> { success, data: { brandName, deviceName, modelNumber }, source }
router.post('/', rateLimit({ windowMs: 60 * 1000, limit: 60 }), async (request, response, next) => {
  try {
    const { status, body } = await identifyDevice(request.body?.imei)
    response.status(status).json(body)
  } catch (error) { next(error) }
})

router.get('/tac/:tac', async (request, response, next) => {
  try {
    const tac = String(request.params.tac)
    if (!/^\d{8}$/.test(tac)) return response.status(400).json({ message: 'TAC must contain exactly 8 digits.' })
    const record = await TACRecord.findOne({ tac }).select('-__v').lean()
    if (!record) return response.status(404).json({ message: 'TAC not found in the local database.' })
    response.json({ record })
  } catch (error) { next(error) }
})

// ---- Admin-only dataset maintenance ----

// Starts an import in the background and returns its id. Prefer the CLI on small hosts:
// a full import holds ~300k records in memory.
router.post('/import', requireAdmin, async (request, response, next) => {
  const known = TAC_SOURCES.map((s) => s.name)
  const sources = Array.isArray(request.body?.sources) ? request.body.sources.filter((s) => known.includes(s)) : undefined
  let started = false
  const job = runTacImport({
    sources, trigger: 'api', userId: request.user._id,
    onStart: (importId) => { started = true; response.status(202).json({ message: 'TAC import started.', importId }) },
  })
  job.catch((error) => {
    if (!started) return error.status ? response.status(error.status).json({ message: error.message }) : next(error)
    console.error(`Background TAC import failed: ${error.message}`)
  })
})

router.get('/import/status', requireAdmin, async (_request, response, next) => {
  try {
    const [total, complete, bySource, latest, running] = await Promise.all([
      TACRecord.estimatedDocumentCount(),
      TACRecord.countDocuments({ brandName: { $gt: '' }, deviceName: { $gt: '' }, modelNumber: { $gt: '' } }),
      TACRecord.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      TACImportLog.findOne({ status: { $ne: 'running' } }).sort({ startedAt: -1 }).select('status startedAt finishedAt totals sources.source sources.version sources.sourceUpdatedAt').lean(),
      TACImportLog.findOne({ status: 'running' }).select('startedAt trigger').lean(),
    ])
    response.json({
      collection: 'TACRecords',
      total,
      complete,
      incomplete: total - complete,
      bySource: bySource.map((s) => ({ source: s._id, count: s.count })),
      lastImport: latest,
      running,
      sources: TAC_SOURCES.map(({ name, label, url, license }) => ({ name, label, url, license })),
    })
  } catch (error) { next(error) }
})

router.get('/import/history', requireAdmin, async (_request, response, next) => {
  try {
    const items = await TACImportLog.find({}).sort({ startedAt: -1 }).limit(25)
      .select('status trigger startedAt finishedAt totals error sources.source sources.version sources.discovered sources.valid sources.imported sources.updated sources.error').lean()
    response.json({ items })
  } catch (error) { next(error) }
})

router.get('/import/history/:id', requireAdmin, async (request, response, next) => {
  try {
    const item = await TACImportLog.findById(request.params.id).lean()
    if (!item) return response.status(404).json({ message: 'Import not found.' })
    response.json({ item })
  } catch (error) { next(error) }
})

export default router
