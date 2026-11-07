const endpoint = 'https://imei.hicelltek.com/api/v1/tac/lookup'

function apiError(message, status = 502) {
  const error = new Error(message)
  error.status = status
  return error
}

export function mapHiCellTekResponse(result) {
  if (!result || result.found !== true) return null
  const brandName = typeof result.brand?.name === 'string' ? result.brand.name.trim() : ''
  const deviceName = typeof result.model === 'string' ? result.model.trim() : ''
  if (!brandName && !deviceName) return null

  return {
    brandName,
    deviceName,
    modelNumber: typeof result.model_number === 'string' ? result.model_number.trim() : '',
  }
}

export async function lookupWithHiCellTek(imei) {
  const apiKey = process.env.HICELLTEK_API_KEY
  if (!apiKey) throw apiError('Set HICELLTEK_API_KEY in the server environment.', 503)

  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: imei }),
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw apiError('Could not reach HiCellTek. Enter device details manually and try again later.', 503)
  }

  const result = await response.json().catch(() => null)
  if (response.status === 401) throw apiError('HiCellTek rejected the API key. Check server configuration.', 502)
  if (response.status === 422) throw apiError('HiCellTek rejected the IMEI format.', 422)
  if (response.status === 429) throw apiError('HiCellTek lookup quota or rate limit was reached.', 429)
  if (response.status === 503) throw apiError('HiCellTek is temporarily unavailable.', 503)
  if (response.status === 404 && result?.found === false) return null
  if (!response.ok) throw apiError('HiCellTek could not complete this lookup.')
  if (!result || typeof result !== 'object') throw apiError('HiCellTek returned an unreadable response.')
  return mapHiCellTekResponse(result)
}