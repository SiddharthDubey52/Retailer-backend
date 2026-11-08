// Hybrid device identification: local TACRecords -> HiCellTek API -> manual entry.
import { isTacConnected } from '../config/database.js'
import { TACRecord } from '../models/tac.js'
import { isValidImei } from '../validation.js'
import { lookupWithHiCellTek } from './hiCellTek.js'
import { compareKey } from './tac/normalize.js'

export const FIELDS = ['brandName', 'deviceName', 'modelNumber']
export const MANUAL_MESSAGE = 'Device details could not be identified automatically. Please enter the details manually.'
const PARTIAL_MESSAGE = 'Some device details could not be identified automatically. Please enter the missing details manually.'

const pickFields = (r) => Object.fromEntries(FIELDS.map((f) => [f, typeof r?.[f] === 'string' ? r[f].trim() : '']))
const missingOf = (data) => FIELDS.filter((f) => !data[f])
const sameBrand = (a, b) => { const [x, y] = [compareKey(a), compareKey(b)]; return !x || !y || x.includes(y) || y.includes(x) }

export async function findLocalTac(tac) {
  if (!isTacConnected()) throw Object.assign(new Error('TAC database cluster is not connected.'), { code: 'db_unavailable' })
  return TACRecord.findOne({ tac }).select('tac brandName deviceName modelNumber source').maxTimeMS(3000).lean()
}

/**
 * Returns { status, body } for POST /api/device-lookup.
 * deps are injectable for tests: { findLocal(tac), lookupRemote(tac) }.
 */
export async function identifyDevice(rawImei, { findLocal = findLocalTac, lookupRemote = lookupWithHiCellTek } = {}) {
  const imei = String(rawImei ?? '').replace(/[\s-]/g, '')
  if (!isValidImei(imei)) {
    return { status: 400, body: { success: false, data: null, source: 'manual_entry', message: 'Enter a valid 15-digit IMEI (check digit failed or wrong length).' } }
  }
  const tac = imei.slice(0, 8)

  // Step 2: local database.
  let local = null
  let localDatabaseAvailable = true
  try {
    const record = await findLocal(tac)
    if (record) local = pickFields(record)
  } catch (error) {
    localDatabaseAvailable = false
    console.error(`Local TAC lookup failed: ${error.message}`)
  }
  if (local && !missingOf(local).length) {
    return { status: 200, body: { success: true, data: local, source: 'local_database', tac, complete: true, missingFields: [] } }
  }

  // Step 3: HiCellTek fallback (missing or incomplete local record).
  let remote = null
  let quota
  let fallbackError = null
  try {
    const result = await lookupRemote(tac)
    remote = result?.data || null
    quota = result?.quota
  } catch (error) {
    fallbackError = { code: error.code || 'hicelltek_error', message: error.message, ...(error.resetAt && { resetAt: error.resetAt }) }
  }

  const extra = { tac, localDatabaseAvailable, ...(quota && { quota }), ...(fallbackError && { fallbackError }) }
  if (remote) {
    const data = pickFields(remote)
    const fieldSources = Object.fromEntries(FIELDS.map((f) => [f, data[f] ? 'hicelltek_api' : null]))
    // Fill gaps from the local record only when both sources name the same brand.
    if (local && sameBrand(local.brandName, data.brandName)) {
      for (const f of FIELDS) if (!data[f] && local[f]) { data[f] = local[f]; fieldSources[f] = 'local_database' }
    }
    const missingFields = missingOf(data)
    return {
      status: 200,
      body: { success: true, data, source: 'hicelltek_api', complete: !missingFields.length, missingFields, fieldSources, ...(missingFields.length && { message: PARTIAL_MESSAGE }), ...extra },
    }
  }
  if (local && FIELDS.some((f) => local[f])) {
    const missingFields = missingOf(local)
    return { status: 200, body: { success: true, data: local, source: 'local_database', complete: false, missingFields, message: PARTIAL_MESSAGE, ...extra } }
  }

  // Step 4: manual entry.
  const unavailable = ['hicelltek_unavailable', 'hicelltek_unreachable', 'hicelltek_not_configured']
  const status = !fallbackError ? 404
    : fallbackError.code === 'hicelltek_quota' ? 429
      : fallbackError.code === 'hicelltek_timeout' ? 504
        : unavailable.includes(fallbackError.code) || !localDatabaseAvailable ? 503 : 502
  return { status, body: { success: false, data: null, source: 'manual_entry', complete: false, missingFields: [...FIELDS], message: MANUAL_MESSAGE, ...extra } }
}
