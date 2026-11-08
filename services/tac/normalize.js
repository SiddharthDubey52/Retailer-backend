// Normalization helpers shared by every TAC source parser.
// Rule: reformat what the source says; never invent a value it does not contain.

const KEEP_UPPER = new Set([
  'LTE', 'NFC', 'GPS', 'TV', 'HD', 'FHD', 'UHD', 'XL', 'XE', 'XS', 'XR', 'XZ', 'SE', 'GT', 'DS',
  'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'NXTPAPER', 'AMOLED', 'SIM',
])
const SPECIAL_WORDS = {
  IPHONE: 'iPhone', IPAD: 'iPad', IPOD: 'iPod', IQOO: 'iQOO', ONEPLUS: 'OnePlus', POCO: 'POCO',
  ASUS: 'ASUS', ROG: 'ROG', ZENFONE: 'Zenfone', HMD: 'HMD', BLU: 'BLU',
}
const BRAND_OVERRIDES = { ...SPECIAL_WORDS, HONOR: 'Honor', REALME: 'Realme', NOTHING: 'Nothing' }

export const clean = (value, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
export const compareKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const isPlaceholder = (value) => /^(n\/?a|null|none|unknown|-+|\?+)$/i.test(String(value).trim())

/** Re-cases an ALL-CAPS token for display. Tokens that already contain lowercase are left untouched. */
function caseWord(word, { brand = false } = {}) {
  if (/[a-z]/.test(word)) return word
  const upper = word.toUpperCase()
  const special = brand ? BRAND_OVERRIDES[upper] : SPECIAL_WORDS[upper]
  if (special) return special
  if (/^[A-Z]{4,}\d+$/.test(word)) return word.charAt(0) + word.slice(1).toLowerCase() // FLIP5 -> Flip5
  if (/\d/.test(word)) return word // model codes like 14S, 5G, A16, SM-S928B
  if (KEEP_UPPER.has(upper)) return upper
  if (upper.replace(/[^A-Z]/g, '').length <= (brand ? 3 : 2)) return upper // LG, TCL, ZTE, HTC / S, XL
  return word.charAt(0) + word.slice(1).toLowerCase()
}

export function displayCase(value, options) {
  return clean(value).split(' ').filter(Boolean).map((word) =>
    word.split('-').map((part) => caseWord(part, options)).join('-')).join(' ')
}

export const normalizeBrand = (value) => (isPlaceholder(value) ? '' : clean(displayCase(value, { brand: true }), 100))

/** Removes a leading brand from a device name ("SAMSUNG GALAXY S24" -> "GALAXY S24"). */
export function stripBrandPrefix(name, brand) {
  const text = clean(name)
  const b = clean(brand)
  if (!b) return text
  if (text.toLowerCase() === b.toLowerCase()) return ''
  if (text.toLowerCase().startsWith(`${b.toLowerCase()} `)) return text.slice(b.length + 1).trim()
  return text
}

export const normalizeDevice = (value) => (isPlaceholder(value) ? '' : clean(displayCase(value), 160))
export const normalizeModelNumber = (value) => (isPlaceholder(value) ? '' : clean(value, 80))

/**
 * Validates a TAC. `allowZeroPadding` is only for sources that document that leading
 * zeros were dropped (MoazEb README: "leading zeros are omitted for legacy allocations").
 */
export function normalizeTac(raw, { allowZeroPadding = false } = {}) {
  const value = String(raw ?? '').trim()
  if (!/^\d+$/.test(value)) return null
  let tac = value
  if (tac.length < 8 && allowZeroPadding && tac.length >= 6) tac = tac.padStart(8, '0')
  if (!/^\d{8}$/.test(tac) || /^0{8}$/.test(tac)) return null
  return tac
}

/** RFC-4180 CSV parser (handles quoted commas, escaped quotes and quoted newlines). */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1
      row.push(field); rows.push(row); row = []; field = ''
    } else field += char
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.length > 1 || r[0])
}
