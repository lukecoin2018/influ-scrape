/**
 * Follower-range gating for imported creators.
 *
 * Deliberately NOT wired into the Discovery page (components/SetupPanel.tsx,
 * defaults 50k/500k) or the Import page (app/import/page.tsx, defaults
 * 30k/500k). Those two discard out-of-range profiles before saving; this one
 * keeps them and flags them. Same numbers, opposite behaviour — the existing
 * defaults stay where they are and get reconciled deliberately, not by a
 * silent unification here.
 */

export const DEFAULT_MIN_FOLLOWERS = 30_000;
export const DEFAULT_MAX_FOLLOWERS = 500_000;

/**
 * Out-of-range is split by direction because the two groups have opposite
 * futures: a below-range creator can grow into range and be promoted back to
 * 'active', while an above-range one never will and is better treated as a
 * separate mega-creator population.
 *
 * Every pipeline filter tests `import_status = 'active'`, so both out-of-range
 * values are excluded identically without any filter needing to know about the
 * split.
 */
export type ImportStatus = 'active' | 'out_of_range_high' | 'out_of_range_low';

export interface FollowerRange {
  min: number;
  max: number;
}

/**
 * A follower_count of 0 or null means the scrape failed or the account is
 * private — not that the account is genuinely tiny. Those are treated as
 * unknown size and stay eligible: enrichment re-scrapes follower counts, so a
 * bad scrape self-corrects on the next pass, whereas an exclusion written on
 * the strength of one does not.
 */
export function isInFollowerRange(
  followerCount: number | null | undefined,
  range: FollowerRange
): boolean {
  if (followerCount === null || followerCount === undefined || followerCount <= 0) {
    return true;
  }
  return followerCount >= range.min && followerCount <= range.max;
}

export function importStatusFor(
  followerCount: number | null | undefined,
  range: FollowerRange
): ImportStatus {
  if (isInFollowerRange(followerCount, range)) return 'active';
  return (followerCount as number) > range.max ? 'out_of_range_high' : 'out_of_range_low';
}

/** True for either out-of-range direction. */
export function isOutOfRange(status: ImportStatus): boolean {
  return status !== 'active';
}

/**
 * Collapses a creator's profile statuses into one creator-level value.
 *
 * A creator is only out of range when every profile is. When the directions
 * disagree — big on one platform, small on another — 'high' wins: being large
 * anywhere makes them a mega-creator rather than someone who might grow into
 * range.
 */
export function rollUpStatuses(statuses: ImportStatus[]): ImportStatus {
  if (statuses.length === 0) return 'active';
  if (statuses.some(s => s === 'active')) return 'active';
  return statuses.some(s => s === 'out_of_range_high') ? 'out_of_range_high' : 'out_of_range_low';
}

/**
 * Only a missing or unparseable bound falls back to the default. An explicit
 * number is honoured, so `min: 0` means "no floor" rather than silently
 * becoming 30,000 — which is what a plain `Number(min) || DEFAULT` does, since
 * 0 is falsy. Negatives clamp to 0 rather than reviving the default, so the
 * two cases agree.
 */
function parseBound(value: unknown, fallback: number, minimum: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return fallback;
  // A max of 0 would exclude everyone; treat it as unset rather than literal.
  if (parsed < minimum) return minimum === 0 ? 0 : fallback;
  return parsed;
}

/** Resolves user-supplied bounds and guards against an inverted range. */
export function normaliseRange(min: unknown, max: unknown): FollowerRange {
  const parsedMin = parseBound(min, DEFAULT_MIN_FOLLOWERS, 0);
  const parsedMax = parseBound(max, DEFAULT_MAX_FOLLOWERS, 1);
  return parsedMin > parsedMax
    ? { min: parsedMax, max: parsedMin }
    : { min: parsedMin, max: parsedMax };
}
