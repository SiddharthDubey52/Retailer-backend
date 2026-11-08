// HiCellTek TAC lookup (purchased API). Docs: https://hicelltek.com/en/imei-api/
// The key stays in the backend environment (HICELLTEK_API_KEY). Responses are NOT stored in the
// local TAC database: HiCellTek's published terms do not grant a storage/reuse right.
import { clean, normalizeBrand, normalizeDevice, stripBrandPrefix } from './tac/normalize.js'

const endpoint = 'https://imei.hicelltek.com/api/v1/tac/lookup'
const timeoutMs = () => Number(process.env.HICELLTEK_TIMEOUT_MS) || 10000
const inFlight = new Map()

function apiError(message, status = 502, code = 'hicelltek_error') {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

/** "Samsung SM-S921B/DS" -> "SM-S921B/DS"; "Realme Chongqing RMX3041" -> "RMX3041". */
export function cleanModelInfo(value, brand) {
  const text = stripBrandPrefix(clean(value, 120), brand)
  if (!text) return ''
  const tokens = text.split(' ')
  const codeAt = tokens.findIndex((t) => (/\d/.test(t) && /[A-Za-z]/.test(t)) || /\d-|-\d/.test(t))
  if (codeAt > 0 && tokens.slice(0, codeAt).every((t) => !/\d/.test(t))) return clean(tokens.slice(codeAt).join(' '), 80)
  return clean(text, 80)
}

/** Maps the documented response: brand.name, marketing_name (fallback model), model_info. */
export function mapHiCellTekResponse(result) {
  if (!result || result.found !== true) return null
  const rawBrand = typeof result.brand?.name === 'string' ? result.brand.name : ''
  const rawDevice = [result.marketing_name, result.model].find((v) => typeof v === 'string' && v.trim()) || ''
  const brandName = normalizeBrand(rawBrand)
  const deviceName = normalizeDevice(stripBrandPrefix(rawDevice, rawBrand))
  const modelNumber = typeof result.model_info === 'string' ? cleanModelInfo(result.model_info, rawBrand) : ''
  if (!brandName && !deviceName && !modelNumber) return null
  return { brandName, deviceName, modelNumber }
}

async function requestLookup(tac, apiKey) {
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: tac }),
      signal: AbortSignal.timeout(timeoutMs()),
    })
  } catch (error) {
    if (error.name === 'TimeoutError') throw apiError('HiCellTek did not respond in time.', 504, 'hicelltek_timeout')
    throw apiError('Could not reach HiCellTek.', 503, 'hicelltek_unreachable')
  }

  const result = await response.json().catch(() => null)
  const remaining = Number(result?.meta?.remaining_lookups ?? response.headers.get('x-ratelimit-remaining'))
  const quota = { remaining: Number.isFinite(remaining) ? remaining : null }
  if (response.status === 401) throw apiError('HiCellTek rejected the API key. Check server configuration.', 502, 'hicelltek_auth')
  if (response.status === 422) throw apiError('HiCellTek rejected the TAC format.', 422, 'hicelltek_invalid')
  if (response.status === 429) {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    throw Object.assign(apiError('HiCellTek lookup quota or rate limit was reached.', 429, 'hicelltek_quota'), {
      resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
    })
  }
  if (response.status === 503) throw apiError('HiCellTek is temporarily unavailable.', 503, 'hicelltek_unavailable')
  if (response.status === 404 && result?.found === false) return { data: null, quota }
  if (!response.ok) throw apiError('HiCellTek could not complete this lookup.', 502)
  if (!result || typeof result !== 'object') throw apiError('HiCellTek returned an unreadable response.', 502)
  return { data: mapHiCellTekResponse(result), quota }
}

/**
 * Looks up an 8-digit TAC. Concurrent lookups for the same TAC share one request,
 * so a double scan never spends two quota units. Resolves { data, quota }.
 */
export function lookupWithHiCellTek(tac) {
  const apiKey = process.env.HICELLTEK_API_KEY
  if (!apiKey) return Promise.reject(apiError('HiCellTek is not configured (HICELLTEK_API_KEY missing).', 503, 'hicelltek_not_configured'))
  if (!/^\d{8}$/.test(tac)) return Promise.reject(apiError('HiCellTek lookups require an 8-digit TAC.', 422, 'hicelltek_invalid'))
  if (!inFlight.has(tac)) {
    inFlight.set(tac, requestLookup(tac, apiKey).finally(() => inFlight.delete(tac)))
  }
  return inFlight.get(tac)
}
