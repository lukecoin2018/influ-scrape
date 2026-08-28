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
 * Below this, a Discovery candidate is cached as a reject rather than archived
 * as a creator. Lives here beside the band it divides; the routing rule that
 * uses it is in discoveryPolicy.ts.
 *
 * A starting value, not a measured one — the first instrumented Discovery run
 * reports the <5k / 5k-15k / 15k-30k split that should set it.
 */
export const NEAR_MISS_FLOOR = 15_000;

/**
 * Out-of-range is split by direction because the two groups have opposite
 * futures: a below-range creator can grow into range and be promoted back to
 * 'active', while an above-range one never will and is better treated as a
 * separate mega-creator population.
 *
 * 'unknown_size' is not an out-of-range verdict at all — it means the follower
 * count has not been measured yet (a failed or private scrape). It is kept
 * distinct from 'out_of_range_low' because a scrape that returned nothing is
 * not evidence of a small account, and conflating the two files unmeasured
 * handles where nothing would ever distinguish them from genuine micro
 * accounts. Unlike the out-of-range values it stays in the live tables rather
 * than the archive: nothing reads the archive, so a row parked there would
 * never be re-measured, whereas enrichment re-scrapes follower counts from
 * social_profiles and is therefore the natural re-check path.
 *
 * Every QUEUE-BUILDING filter tests `import_status = 'active'`, so all three
 * non-active values are excluded identically without any filter needing to
 * know about the split. Note that several BY-HANDLE paths deliberately do not
 * apply that gate (enrich 'specific' mode, embeddings by-handle, the
 * intelligence override): naming a handle explicitly is meant to reach it.
 */
export type ImportStatus =
  | 'active'
  | 'out_of_range_high'
  | 'out_of_range_low'
  | 'unknown_size';

export interface FollowerRange {
  min: number;
  max: number;
}

/**
 * A follower_count of 0, null or non-finite means the scrape failed or the
 * account is private — not that the account is genuinely tiny.
 *
 * This used to be folded into isInFollowerRange(), which returned true for
 * those and so stamped them 'active'. Brand-feed never exposed the problem:
 * its archive holds no zero-follower rows at all, because a handle a brand
 * tagged almost always resolves. Hashtag and keyword discovery has no such
 * selection step and hits private, deleted and rate-limited profiles
 * constantly, so an unmeasured count had to become sayable rather than being
 * silently treated as a pass.
 */
export function hasMeasuredFollowerCount(
  followerCount: number | null | undefined
): followerCount is number {
  return typeof followerCount === 'number'
    && Number.isFinite(followerCount)
    && followerCount > 0;
}

/**
 * Whether a count is known to sit inside the band.
 *
 * An unmeasured count is not in range — it is not known to be anywhere. The
 * only caller is importStatusFor(), which separates the unmeasured case first,
 * so this never has to express "unknown" in a boolean.
 */
export function isInFollowerRange(
  followerCount: number | null | undefined,
  range: FollowerRange
): boolean {
  if (!hasMeasuredFollowerCount(followerCount)) return false;
  return followerCount >= range.min && followerCount <= range.max;
}

export function importStatusFor(
  followerCount: number | null | undefined,
  range: FollowerRange
): ImportStatus {
  if (!hasMeasuredFollowerCount(followerCount)) return 'unknown_size';
  if (isInFollowerRange(followerCount, range)) return 'active';
  return followerCount > range.max ? 'out_of_range_high' : 'out_of_range_low';
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
 *
 * 'unknown_size' loses to every measured verdict, because a reading we have
 * beats one we do not. A creator who is 18k on Instagram and unmeasured on
 * TikTok is a below-range creator, not an unmeasured one. Only when NO profile
 * has been measured does the creator itself become 'unknown_size'.
 */
export function rollUpStatuses(statuses: ImportStatus[]): ImportStatus {
  if (statuses.length === 0) return 'active';
  if (statuses.some(s => s === 'active')) return 'active';
  if (statuses.some(s => s === 'out_of_range_high')) return 'out_of_range_high';
  if (statuses.some(s => s === 'out_of_range_low')) return 'out_of_range_low';
  return 'unknown_size';
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
