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
