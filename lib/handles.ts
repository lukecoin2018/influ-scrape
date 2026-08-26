/**
 * Parsing and validation for user-entered Instagram handles.
 *
 * Splitting on newlines alone meant a space-separated list arrived as one
 * token: "@loccitane glossier" became the single handle "loccitane glossier",
 * and a longer pasted list became one string long enough to overflow
 * brands.instagram_handle (varchar(64)) with a Postgres error covering the
 * whole batch rather than the one bad entry.
 */

/** Instagram's own limit. The brands column allows 64, but 30 is the real cap. */
export const MAX_HANDLE_LENGTH = 30;
export const MIN_HANDLE_LENGTH = 2;

/**
 * Instagram handles are [a-zA-Z0-9._], 1–30 characters. Single characters and
 * all-numeric tokens are rejected as noise — they are almost always a stray
 * separator or a caption fragment rather than a real account.
 */
export function isValidInstagramHandle(handle: string): boolean {
  if (handle.length < MIN_HANDLE_LENGTH || handle.length > MAX_HANDLE_LENGTH) return false;
  if (!/^[a-z0-9._]+$/.test(handle)) return false;
  if (/^\d+$/.test(handle)) return false;
  return true;
}

/** Why a token was rejected, phrased for display next to the offending input. */
export function handleRejectionReason(handle: string): string | null {
  if (handle.length < MIN_HANDLE_LENGTH) return 'too short';
  if (handle.length > MAX_HANDLE_LENGTH) {
    return `too long — ${handle.length} characters, Instagram allows ${MAX_HANDLE_LENGTH}`;
  }
  if (!/^[a-z0-9._]+$/.test(handle)) {
    const bad = [...new Set(handle.split('').filter(c => !/[a-z0-9._]/.test(c)))];
    return `invalid character${bad.length === 1 ? '' : 's'}: ${bad.map(c => `"${c}"`).join(' ')}`;
  }
  if (/^\d+$/.test(handle)) return 'numeric only';
  return null;
}

/**
 * Normalises a single token to a usable handle, or null.
 *
 * Lowercases, strips a leading @ and trailing dots, then validates. Shared by
 * every path that turns scraped or typed text into a handle, so they cannot
 * drift apart on what counts as legal.
 *
 * TikTok usernames use the same character set as Instagram (letters, digits,
 * period, underscore) with a shorter max, so the Instagram rule is a safe
 * superset for both.
 */
export function normaliseHandleToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const handle = raw
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/\.+$/, '');

  return isValidInstagramHandle(handle) ? handle : null;
}

/**
 * Pulls handles out of an actor-supplied array.
 *
 * Scrapers return these as objects ({ username }, { name }, { uniqueId }) or
 * as bare strings depending on the actor and field; anything that does not
 * normalise to a legal handle is dropped.
 */
export function handlesFromActorList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];

  return list
    .map(entry => {
      if (typeof entry === 'string') return normaliseHandleToken(entry);
      if (entry && typeof entry === 'object') {
        const o = entry as Record<string, unknown>;
        return normaliseHandleToken(o.username ?? o.uniqueId ?? o.name ?? o.nickname);
      }
      return null;
    })
    .filter((h): h is string => h !== null);
}

/**
 * Handles mentioned in a caption.
 *
 * Two rules, and the second matters as much as the first:
 *
 *  1. Only legal username characters are captured. The previous pattern also
 *     accepted accents, apostrophes and hyphens, which no platform permits in
 *     a username — it was lifting brand NAMES out of caption prose.
 *
 *  2. The match must END at a word boundary. Narrowing the character class
 *     alone does not reject "@loréal" — it truncates it to "lor", trading an
 *     invalid handle for a meaningless fragment, which is the same class of
 *     junk as "the", "one" and "la". The negative lookahead drops the token
 *     entirely when a word character follows, so "@loréal", "@coca-cola" and
 *     "@kiehl's" yield nothing rather than a stub.
 *
 * A trailing dot is still fine: "@brandname." captures "brandname." — the dot
 * is in the class — and the trailing dot is stripped on normalisation.
 *
 * What this CANNOT fix is a display name broken by a space: "@Huda Beauty"
 * legitimately terminates at the space and yields "huda". That is why the
 * TikTok path reads the actor's resolved mention fields instead of the
 * caption; captions there carry display names, not usernames.
 */
export function extractMentionsFromCaption(caption: string): string[] {
  return [...new Set(findMentionsInCaption(caption).map(m => m.handle))];
}

export interface CaptionMention {
  handle: string;
  /** Offset of the '@' in the caption, for callers that inspect context. */
  index: number;
  /** Length of the matched text including the '@'. */
  matchLength: number;
}

/**
 * The single mention pattern. Positional, so callers that need the surrounding
 * text (collab-word proximity, "x @brand") share the same boundary rule rather
 * than each carrying their own copy of it.
 */
const MENTION_PATTERN = /@[a-zA-Z0-9._]+(?![A-Za-z0-9\u00C0-\u024F'\u2019-])/g;

export function findMentionsInCaption(caption: string): CaptionMention[] {
  const out: CaptionMention[] = [];
  if (!caption) return out;

  const pattern = new RegExp(MENTION_PATTERN.source, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(caption)) !== null) {
    const handle = normaliseHandleToken(match[0]);
    if (handle) out.push({ handle, index: match.index, matchLength: match[0].length });
  }

  return out;
}

export interface ParsedHandles {
  valid: string[];
  invalid: { input: string; reason: string }[];
}

/**
 * Splits a free-text handle list into normalised handles.
 *
 * Accepts any mix of newlines, spaces, tabs, commas and semicolons, so a
 * pasted column, a comma list and a space-separated line all work. Strips a
 * leading @, lowercases, and de-duplicates while preserving input order.
 *
 * Invalid tokens are returned rather than dropped: one bad entry should
 * report itself, not fail the batch or vanish silently.
 */
export function parseHandleList(input: string): ParsedHandles {
  const tokens = (input || '')
    .split(/[\s,;]+/)
    .map(token => token.trim().toLowerCase().replace(/^@+/, ''))
    .filter(Boolean);

  const valid: string[] = [];
  const invalid: { input: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);

    const reason = handleRejectionReason(token);
    if (reason) invalid.push({ input: token, reason });
    else valid.push(token);
  }

  return { valid, invalid };
}
