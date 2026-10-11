/**
 * Bio-text signals for the Intelligence step: country/city and the stopword
 * language heuristic. Pure — no network, no database — so it can be tested;
 * app/api/intelligence/analyze builds a client at module scope and cannot be
 * imported by a test (docs/deferred-cleanups.md item 9).
 *
 * Moved out of that route unchanged except where marked below.
 */

// ── Location ──────────────────────────────────────────────────────────────────

/** Where a detected country came from. Only 'email_tld' is a fallback. */
export type CountrySource = 'flag' | 'city' | 'country_name' | 'email_tld';

export interface DetectedLocation {
  country: string | null;
  city: string | null;
  raw: string | null;
  countrySource: CountrySource | null;
}

const FLAG_MAP: Record<string, string> = {
  '🇺🇸': 'United States', '🇬🇧': 'United Kingdom', '🇩🇪': 'Germany',
  '🇫🇷': 'France', '🇪🇸': 'Spain', '🇮🇹': 'Italy',
  '🇳🇱': 'Netherlands', '🇧🇪': 'Belgium', '🇦🇹': 'Austria',
  '🇨🇭': 'Switzerland', '🇸🇪': 'Sweden', '🇩🇰': 'Denmark',
  '🇳🇴': 'Norway', '🇵🇹': 'Portugal', '🇧🇷': 'Brazil',
  '🇲🇽': 'Mexico', '🇨🇦': 'Canada', '🇦🇺': 'Australia',
  '🇯🇵': 'Japan', '🇰🇷': 'South Korea', '🇮🇳': 'India',
  '🇹🇷': 'Turkey', '🇿🇦': 'South Africa', '🇦🇪': 'UAE',
  '🇸🇦': 'Saudi Arabia', '🇵🇱': 'Poland', '🇷🇴': 'Romania',
  '🇭🇺': 'Hungary', '🇨🇿': 'Czech Republic', '🇬🇷': 'Greece',
  '🇮🇪': 'Ireland', '🇫🇮': 'Finland', '🇭🇷': 'Croatia',
  '🇷🇸': 'Serbia', '🇧🇬': 'Bulgaria', '🇺🇦': 'Ukraine',
  '🇵🇭': 'Philippines', '🇮🇩': 'Indonesia', '🇹🇭': 'Thailand',
  '🇻🇳': 'Vietnam', '🇲🇾': 'Malaysia', '🇸🇬': 'Singapore',
  '🇳🇬': 'Nigeria', '🇰🇪': 'Kenya', '🇪🇬': 'Egypt',
  '🇨🇴': 'Colombia', '🇦🇷': 'Argentina', '🇨🇱': 'Chile', '🇵🇪': 'Peru',
};

const CITY_MAP: Record<string, string> = {
  'new york': 'United States', 'nyc': 'United States', 'los angeles': 'United States',
  'la': 'United States', 'chicago': 'United States', 'miami': 'United States',
  'san francisco': 'United States', 'sf': 'United States', 'atlanta': 'United States',
  'houston': 'United States', 'dallas': 'United States', 'seattle': 'United States',
  'boston': 'United States', 'nashville': 'United States', 'denver': 'United States',
  'london': 'United Kingdom', 'manchester': 'United Kingdom', 'birmingham': 'United Kingdom',
  'edinburgh': 'United Kingdom', 'glasgow': 'United Kingdom', 'liverpool': 'United Kingdom',
  'berlin': 'Germany', 'munich': 'Germany', 'münchen': 'Germany',
  'hamburg': 'Germany', 'frankfurt': 'Germany', 'cologne': 'Germany', 'köln': 'Germany',
  'düsseldorf': 'Germany', 'stuttgart': 'Germany',
  // Added 2026-10 for DACH, local and English spellings both.
  'leipzig': 'Germany', 'nürnberg': 'Germany', 'nuernberg': 'Germany', 'nuremberg': 'Germany',
  'paris': 'France', 'lyon': 'France', 'marseille': 'France',
  'madrid': 'Spain', 'barcelona': 'Spain', 'valencia': 'Spain',
  'rome': 'Italy', 'milan': 'Italy', 'milano': 'Italy',
  'amsterdam': 'Netherlands', 'rotterdam': 'Netherlands',
  'brussels': 'Belgium', 'antwerp': 'Belgium',
  'vienna': 'Austria', 'wien': 'Austria',
  'graz': 'Austria', 'linz': 'Austria', 'salzburg': 'Austria', 'innsbruck': 'Austria',
  'zurich': 'Switzerland', 'zürich': 'Switzerland', 'geneva': 'Switzerland',
  'basel': 'Switzerland', 'bâle': 'Switzerland', 'bern': 'Switzerland', 'berne': 'Switzerland',
  'stockholm': 'Sweden', 'copenhagen': 'Denmark', 'oslo': 'Norway',
  'lisbon': 'Portugal', 'dublin': 'Ireland', 'helsinki': 'Finland',
  'prague': 'Czech Republic', 'warsaw': 'Poland', 'budapest': 'Hungary',
  'athens': 'Greece', 'istanbul': 'Turkey',
  'toronto': 'Canada', 'vancouver': 'Canada', 'montreal': 'Canada',
  'sydney': 'Australia', 'melbourne': 'Australia',
  'tokyo': 'Japan', 'seoul': 'South Korea',
  'mumbai': 'India', 'delhi': 'India', 'bangalore': 'India',
  'dubai': 'UAE', 'abu dhabi': 'UAE',
  'são paulo': 'Brazil', 'rio de janeiro': 'Brazil',
  'mexico city': 'Mexico', 'buenos aires': 'Argentina',
  'cape town': 'South Africa', 'johannesburg': 'South Africa',
  'lagos': 'Nigeria', 'nairobi': 'Kenya', 'cairo': 'Egypt',
};

/**
 * Country-code email domains that name a country unambiguously enough to use
 * when nothing else does. DACH only: a .de/.at/.ch mailbox is a German-speaking
 * provider (gmx.de, web.de, bluewin.ch) or a local agency.
 *
 * Measured 2026-10-11: of 72 profiles with a .de/.at/.ch address or an
 * Impressum in the bio, 49 were already DACH or German by other signals.
 * Agencies are the known weakness — a German agency can represent a creator
 * elsewhere — which is why this never overrides any other source.
 */
export const EMAIL_TLD_COUNTRY: Record<string, string> = {
  de: 'Germany',
  at: 'Austria',
  ch: 'Switzerland',
};

/**
 * The country the bio's email addresses point to, or null when none maps or
 * when they point to different countries.
 */
export function countryFromEmailTld(emails: string[]): string | null {
  const countries = new Set<string>();
  for (const email of emails) {
    const tld = /\.([a-z]{2,})$/i.exec(email.trim())?.[1]?.toLowerCase();
    const country = tld ? EMAIL_TLD_COUNTRY[tld] : undefined;
    if (country) countries.add(country);
  }
  return countries.size === 1 ? [...countries][0] : null;
}

/**
 * What a profile already knows about its country, for deciding whether a
 * fallback may be written.
 */
export interface StoredCountry {
  detectedCountry: string | null;
  placeCountryCode: string | null;
  /** intelligence_data.country_source — 'email_tld' when the fallback wrote it. */
  countrySource: string | null;
}

/**
 * An email-TLD country is written only when nothing else has set one: no bio
 * signal this pass (the caller only asks when there was none), no country
 * stored from any source, and no geotag country. A country the fallback wrote
 * itself on an earlier pass may be refreshed.
 */
export function mayWriteEmailTldCountry(stored: StoredCountry): boolean {
  if (stored.placeCountryCode) return false;
  if (!stored.detectedCountry) return true;
  return stored.countrySource === 'email_tld';
}

export function detectLocation(bio: string, emails: string[] = []): DetectedLocation {
  if (!bio) return { country: null, city: null, raw: null, countrySource: null };

  let country: string | null = null;
  let countrySource: CountrySource | null = null;
  let city: string | null = null;
  let raw: string | null = null;

  // Flag emojis
  for (const [flag, countryName] of Object.entries(FLAG_MAP)) {
    if (bio.includes(flag)) { country = countryName; countrySource = 'flag'; break; }
  }

  // 📍 pin pattern
  const pinMatch = bio.match(/📍\s*([^,\n]+(?:,\s*[^,\n]+)?)/);
  if (pinMatch) raw = pinMatch[1].trim();

  // "Based in / From / Living in" pattern
  const basedInMatch = bio.match(/(?:based in|from|living in|located in)\s+([A-Za-zÀ-ÿ\s]+)/i);
  if (basedInMatch) raw = raw || basedInMatch[1].trim();

  // City matching
  const bioLower = bio.toLowerCase();
  for (const [cityName, countryName] of Object.entries(CITY_MAP)) {
    const regex = new RegExp(`\\b${cityName}\\b`, 'i');
    if (regex.test(bioLower)) {
      city = cityName.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (!country) { country = countryName; countrySource = 'city'; }
      break;
    }
  }

  // Country name direct mention
  if (!country) {
    const countryNames = [...new Set([...Object.values(FLAG_MAP), ...Object.values(CITY_MAP)])];
    for (const c of countryNames) {
      if (bioLower.includes(c.toLowerCase())) { country = c; countrySource = 'country_name'; break; }
    }
  }

  // Email TLD — the last resort, and only within this bio. Whether it may be
  // WRITTEN also depends on what is already stored; see mayWriteEmailTldCountry.
  if (!country) {
    const fallback = countryFromEmailTld(emails);
    if (fallback) { country = fallback; countrySource = 'email_tld'; }
  }

  return { country, city, raw, countrySource };
}

// ── Language ──────────────────────────────────────────────────────────────────

export const LANGUAGE_SIGNALS: Record<string, string[]> = {
  en: ['the', 'and', 'you', 'for', 'this', 'with', 'that', 'have', 'from', 'your', 'just', 'love', 'new', 'day', 'out', 'about', 'what', 'when'],
  de: ['und', 'die', 'der', 'das', 'ist', 'ich', 'nicht', 'ein', 'mit', 'auch', 'auf', 'für', 'mein', 'aber', 'wir', 'noch', 'wie', 'hier'],
  es: ['que', 'los', 'las', 'del', 'por', 'con', 'una', 'para', 'esta', 'como', 'pero', 'más', 'todo', 'sus', 'muy', 'también'],
  fr: ['les', 'des', 'une', 'est', 'que', 'pour', 'pas', 'dans', 'sur', 'avec', 'plus', 'tout', 'cette', 'mon', 'mais', 'aussi'],
  it: ['che', 'non', 'per', 'una', 'con', 'sono', 'questo', 'come', 'anche', 'più', 'della', 'molto', 'tutto', 'mia', 'dalla'],
  pt: ['que', 'não', 'para', 'com', 'uma', 'mais', 'como', 'mas', 'por', 'muito', 'sua', 'esta', 'também', 'isso', 'quando'],
  nl: ['het', 'een', 'van', 'dat', 'niet', 'met', 'voor', 'ook', 'maar', 'wel', 'nog', 'naar', 'deze', 'mijn', 'haar'],
  tr: ['bir', 'bu', 'için', 'ile', 'çok', 'olan', 'gibi', 'daha', 'ben', 'var', 'ama', 'kadar', 'olarak'],
  ar: ['في', 'من', 'على', 'إلى', 'هذا', 'عن', 'مع', 'لا', 'ما', 'هو', 'كل'],
};

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;
// Any whitespace-delimited token with a dot between two letters or digits:
// gmail.com, linktr.ee/x, shopltk.com/explore, @brand.de. Dropping the whole
// token also drops the odd "z.B." or a missing space after a full stop, which
// costs nothing — neither is a stopword.
const DOMAIN_TOKEN_PATTERN = /\S*[\p{L}\p{N}]\.[\p{L}\p{N}]\S*/gu;

/**
 * Removes emails, URLs and domains before tokenising.
 *
 * CHANGED 2026-10: the tokeniser splits on '.', so "yahoo.com" became the
 * token "com" — a Portuguese stopword. @jackyinberlin was labelled pt on that
 * one token alone. 418 of the 618 profiles labelled pt had ".com" in the bio,
 * and where the actor also had an answer it agreed on pt for only 22 of 75.
 */
export function stripNonLanguageTokens(text: string): string {
  return text
    .replace(EMAIL_PATTERN, ' ')
    .replace(URL_PATTERN, ' ')
    .replace(DOMAIN_TOKEN_PATTERN, ' ');
}

/** Stopword hits per language, highest first; languages with none omitted. */
export function scoreLanguages(bio: string, captions: string[]): [string, number][] {
  const allText = stripNonLanguageTokens([bio, ...captions.slice(0, 5)].filter(Boolean).join(' '));
  const words = allText.toLowerCase().split(/[\s,.!?;:'"()\[\]{}#@]+/).filter((w) => w.length > 1);
  const scores: Record<string, number> = {};

  for (const [lang, signals] of Object.entries(LANGUAGE_SIGNALS)) {
    scores[lang] = 0;
    for (const word of words) {
      if (signals.includes(word)) scores[lang]++;
    }
  }

  return Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);
}

export function detectLanguage(bio: string, captions: string[]): { primary: string; all: string[] } {
  const allText = [bio, ...captions.slice(0, 5)].filter(Boolean).join(' ');
  if (!allText || allText.length < 20) return { primary: 'unknown', all: [] };

  const sorted = scoreLanguages(bio, captions);
  if (sorted.length === 0) return { primary: 'unknown', all: [] };

  // CHANGED 2026-10: a tie is no answer. The sort is stable, so a tie used to
  // go to whichever language the table lists first — en, then de, es, fr…
  // @luhtrends, a Brazilian shop account, scored de 1 ("das", also Portuguese),
  // es 1, pt 1 and was labelled German by list order.
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return { primary: 'unknown', all: [] };

  const primary = sorted[0][0];
  const all = sorted.filter(([, score]) => score > 2).map(([lang]) => lang);
  return { primary, all: all.length > 0 ? all : [primary] };
}
