export function isValidImei(value) {
  if (!/^\d{15}$/.test(value)) return false
  let sum = 0
  let doubleDigit = true
  for (let index = value.length - 2; index >= 0; index -= 1) {
    let digit = Number(value[index])
    if (doubleDigit) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    doubleDigit = !doubleDigit
  }
  return (sum + Number(value.at(-1))) % 10 === 0
}