// Shared normalization rules for detected_country / detected_city, applied at
// write time so bad values never land in social_profiles / creators.
// Mirrors the cleanup rules applied to the historical backlog in lmg-media
// (see lmg-media CLAUDE.md / city-page-consistency work, July 2026).

export const COUNTRY_ALIASES: Record<string, string> = {
  'UAE': 'United Arab Emirates',
  'U.A.E.': 'United Arab Emirates',
  'USA': 'United States',
  'U.S.A.': 'United States',
  'US': 'United States',
  'UK': 'United Kingdom',
  'U.K.': 'United Kingdom',
}

const NULL_LIKE = new Set(['null', 'n/a', 'na', 'none', 'unknown', 'undefined', ''])

export function coerceNullLike(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (NULL_LIKE.has(trimmed.toLowerCase())) return null
  return trimmed
}

export function canonicalCountry(country: string | null): string | null {
  const coerced = coerceNullLike(country)
  if (!coerced) return null
  return COUNTRY_ALIASES[coerced] ?? coerced
}

// Real cities only, please - these are states/provinces/regions, not cities.
const US_STATE_NAMES = new Set([
  'Florida', 'California', 'Texas', 'Utah', 'Arizona', 'New Jersey', 'Minnesota',
  'Michigan', 'North Carolina', 'Illinois', 'Oregon', 'Hawaii', 'Alabama',
  'Louisiana', 'Pennsylvania', 'Arkansas', 'Georgia', 'Oklahoma', 'Connecticut',
  'Missouri', 'Colorado', 'Mississippi', 'Virginia', 'New York State', 'Nevada',
  'Washington State', 'Ohio', 'Tennessee', 'Indiana', 'Wisconsin', 'Maryland',
  'Kentucky', 'South Carolina', 'Iowa', 'Kansas', 'Idaho', 'Montana', 'Wyoming',
  'New Mexico', 'Nebraska', 'Vermont', 'Maine', 'New Hampshire', 'Rhode Island',
  'Delaware', 'Alaska', 'West Virginia', 'North Dakota', 'South Dakota',
])

const NON_US_ADMIN_REGION_NAMES = new Set([
  'Sonora', 'Nuevo León', 'Santa Catarina', 'Baden-Württemberg', 'Andalusia',
  'Catalonia', 'Canary Islands', 'Asturias', 'Bahia', 'Goiás', 'Sergipe',
  'Manabí', 'Kashmir', 'Uttarakhand', 'Madhya Pradesh', 'Aragua', 'Sicily',
  'Puglia', 'Dolomites', 'Corsica',
])

const DESCRIPTIVE_REGION_NAMES = new Set([
  'South Florida', 'Southern California', 'Southwest Florida', 'Long Island',
  'Orange County', 'New England', "Cote d'Azur", 'South of France',
])

// Truncated 2-3 letter codes are only reliably resolvable in specific countries -
// e.g. "La" means Los Angeles in a US context but was a false-positive elsewhere
// (a truncated "Lima", a stray Spanish article, etc.) in the historical backlog.
// Deliberately scoped narrow; do not add entries without sample-text confirmation.
const TRUNCATED_CITY_MAP: Record<string, Record<string, string>> = {
  'united states': { 'la': 'Los Angeles', 'nyc': 'New York', 'sf': 'San Francisco' },
  'mexico': { 'la': 'Los Angeles' }, // LA-based creators with Mexican heritage mis-tagged by country
}

// Accent / spelling duplicates -> one canonical form per country.
const CITY_ALIASES: Record<string, Record<string, string>> = {
  'colombia': { 'medellin': 'Medellín', 'cartagena de indias': 'Cartagena' },
  'brazil': { 'rio de janeiro': 'Rio de Janeiro', 'rio': 'Rio de Janeiro' },
  'italy': { 'milano': 'Milan' },
  'switzerland': { 'zurich': 'Zürich' },
  'united states': { 'washington dc': 'Washington' },
}

export function canonicalCity(city: string | null, country: string | null): string | null {
  const coercedCity = coerceNullLike(city)
  if (!coercedCity) return null

  if (US_STATE_NAMES.has(coercedCity)) return null
  if (NON_US_ADMIN_REGION_NAMES.has(coercedCity)) return null
  if (DESCRIPTIVE_REGION_NAMES.has(coercedCity)) return null

  const countryKey = (canonicalCountry(country) || '').toLowerCase()
  const lower = coercedCity.toLowerCase()

  const truncated = TRUNCATED_CITY_MAP[countryKey]?.[lower]
  if (truncated) return truncated

  const alias = CITY_ALIASES[countryKey]?.[lower]
  if (alias) return alias

  return coercedCity
}

// Cities unambiguous enough that a mismatched country is almost certainly an
// extraction error (heritage/audience-language overriding an explicit "based
// in" statement) rather than a real edge case. Deliberately excludes names
// that legitimately exist in more than one country (London/Ontario,
// Guadalajara/Spain, Valencia/Venezuela, Santiago/multiple, etc.) - those need
// a human, not a rule.
export const CITY_COUNTRY_PLAUSIBILITY: Record<string, string> = {
  'miami': 'United States',
  'los angeles': 'United States',
  'new york': 'United States',
  'san francisco': 'United States',
  'houston': 'United States',
  'chicago': 'United States',
  'madrid': 'Spain',
  'barcelona': 'Spain',
  'paris': 'France',
  'dubai': 'United Arab Emirates',
  'milan': 'Italy',
  'rome': 'Italy',
  'medellín': 'Colombia',
  'bogotá': 'Colombia',
  'cartagena': 'Colombia',
  'mexico city': 'Mexico',
  'são paulo': 'Brazil',
  'rio de janeiro': 'Brazil',
  'berlin': 'Germany',
  'tokyo': 'Japan',
  'sydney': 'Australia',
}

/**
 * Returns false only when both city and country are known, the city is on
 * the unambiguous list above, and the country doesn't match - i.e. a
 * confident, checkable mismatch. Anything not on the list passes through
 * (we can't plausibility-check what we don't have an answer for).
 */
export function isPlausibleCityCountryPair(city: string | null, country: string | null): boolean {
  if (!city || !country) return true
  const expected = CITY_COUNTRY_PLAUSIBILITY[city.toLowerCase()]
  if (!expected) return true
  return expected === country
}

export function isValidLocationField(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}
