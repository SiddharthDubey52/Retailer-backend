import { Router } from 'express'
import { z } from 'zod'
import { TacRecord } from '../models/index.js'
import { importOsmocomTacDatabase } from '../services/osmocomTac.js'
import { lookupWithHiCellTek } from '../services/hiCellTek.js'
import { isValidImei } from '../validation.js'

const router = Router()
const lookupSchema = z.object({ imei: z.string().refine(isValidImei, 'Enter a valid 15-digit IMEI.') })
const notFoundMessage = 'Device information not found. Please enter the details manually.'

router.post('/', async (request, response) => {
  const parsed = lookupSchema.safeParse({ imei: String(request.body?.imei || '').replace(/\D/g, '') })
  if (!parsed.success) return response.status(400).json({ success: false, message: 'Enter a valid 15-digit IMEI.' })

  const tac = parsed.data.imei.slice(0, 8)
  let localLookupError = false
  try {
    const record = await TacRecord.findOne({ tac }).lean()
    if (record) {
      return response.json({
        success: true,
        data: { brandName: record.brandName, deviceName: record.deviceName, modelNumber: record.modelNumber || '' },
        source: 'local_database',
      })
    }
  } catch (error) {
    localLookupError = true
    console.error(`Local TAC lookup failed: ${error.message}`)
  }

  try {
    const data = await lookupWithHiCellTek(parsed.data.imei)
    if (data) {
      if (data.brandName && data.deviceName) {
        try {
          await TacRecord.updateOne(
            { tac },
            {
              $setOnInsert: {
                tac,
                ...data,
                source: 'hicelltek_api',
                lastUpdated: new Date(),
              },
            },
            { upsert: true },
          )
        } catch (cacheError) {
          if (cacheError.code !== 11000) console.error(`Could not cache IMEI lookup: ${cacheError.message}`)
        }
      }
      return response.json({ success: true, data, source: 'external_api' })
    }
    return response.json({ success: false, data: null, source: 'manual_entry', message: notFoundMessage })
  } catch (error) {
    return response.json({
      success: false,
      data: null,
      source: 'manual_entry',
      message: notFoundMessage,
      externalError: error.message,
      localDatabaseUnavailable: localLookupError,
    })
  }
})

router.get('/tac/:tac', async (request, response, next) => {
  try {
    const tac = String(request.params.tac)
    if (!/^\d{8}$/.test(tac)) return response.status(400).json({ message: 'TAC must contain exactly 8 digits.' })
    const record = await TacRecord.findOne({ tac }).lean()
    if (!record) return response.status(404).json({ message: 'TAC not found.' })
    response.json({ record })
  } catch (error) { next(error) }
})

router.post('/import', async (_request, response, next) => {
  try {
    response.status(200).json(await importOsmocomTacDatabase())
  } catch (error) { next(error) }
})

router.get('/import/status', async (_request, response, next) => {
  try {
    const [count, latest] = await Promise.all([
      TacRecord.countDocuments({}),
      TacRecord.findOne({}).sort({ lastUpdated: -1 }).select('source lastUpdated').lean(),
    ])
    response.json({ count, source: latest?.source || null, lastUpdated: latest?.lastUpdated || null })
  } catch (error) { next(error) }
})

export default router