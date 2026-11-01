const { getCountries, getCountryCallingCode, parsePhoneNumberFromString } = require('libphonenumber-js')

const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })

let cachedCountries = null

function flagFor(iso) {
  return [...iso].map((character) => String.fromCodePoint(127397 + character.charCodeAt(0))).join('')
}

function listCountries() {
  if (cachedCountries) return cachedCountries
  cachedCountries = getCountries()
    .map((iso) => ({
      iso,
      name: displayNames.of(iso) || iso,
      dialCode: `+${getCountryCallingCode(iso)}`,
      flag: flagFor(iso),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return cachedCountries
}

function isCountryCode(value) {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && getCountries().includes(value)
}

function parsePhone(input, country) {
  const value = String(input || '').trim()
  if (!value) return null
  return parsePhoneNumberFromString(value, isCountryCode(country) ? country : undefined)
}

function normalizePhone(input, country) {
  const parsed = parsePhone(input, country)
  if (!parsed || !parsed.isValid()) return null
  return parsed.number
}

function formatPhone(value) {
  if (!value) return ''
  try {
    const parsed = parsePhoneNumberFromString(String(value))
    return parsed ? parsed.formatInternational() : String(value)
  } catch {
    return String(value)
  }
}

function countryForPhone(value) {
  try {
    const parsed = parsePhoneNumberFromString(String(value || ''))
    return parsed?.country || null
  } catch {
    return null
  }
}

module.exports = { listCountries, isCountryCode, normalizePhone, formatPhone, countryForPhone }
