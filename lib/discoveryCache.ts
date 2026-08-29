import { looseHandle as norm } from './handles';
import type { FollowerRange } from './followerRange';

/**
 * Reject-cache semantics — pure, no database.
 *
 * Split from discoveryRun.ts for the same reason profileImportCore is split
 * from profileImport: anything importing ./supabase constructs a client at
 * module scope and throws without credentials, so a unit test could not reach
 * these rules. They are the rules most worth testing — a wrong answer here
 * either re-pays for a scrape or permanently excludes a creator.
 *
 * Schema in docs/migrations/2026-08-28-discovery-candidates.sql.
 */

/** Mirrors the CHECK constraint on discovery_candidates.outcome. */
export const CANDIDATE_OUTCOMES = [
  'entity_excluded',
  'already_known',
  'cached_reject',
  'not_scraped',
  'scrape_missing',
  'imported_active',
  'imported_archive_high',
  'imported_archive_low',
  'rejected_below_floor',
  'rejected_above_max',
  'import_failed',
  'unknown_size',
] as const;

export type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

/**
 * How long a follower reading is trusted before the handle is re-scraped.
 *
 * 90 days, matching the staleDays default the enrichment queue uses. The
 * reject is soft in two independent ways: it expires, and it is re-evaluated
 * against the CURRENT band on every run.
 */
export const REJECT_CACHE_TTL_DAYS = 90;

export interface CachedMeasurement {
  platform: string;
  handle: string;
  followerCount: number;
  measuredAt: string;
}

/**
 * Whether a previously measured handle should be skipped this run.
 *
 * Pure, so the re-admission rules are testable without a database.
 *
 * Three conditions, all required:
 *
 *   1. There is a measurement at all.
 *   2. It is still OUTSIDE the current band — in either direction. Discovery
 *      caches above-max handles as well as below-min ones, so a check against
 *      the minimum alone would re-scrape every mega-account on every run.
 *      Comparing against the CURRENT band rather than the one in force when the
 *      reading was taken is what makes the reject soft: lower the band to 15k
 *      and every handle cached at 18k re-enters immediately, with no wait.
 *   3. It has not expired.
 *
 * A stale reading is only ever wrong conservatively — a handle cached at 18k
 * that has since grown to 40k stays excluded until the TTL lapses. It can
 * never be wrongly INCLUDED, and the alternative is paying to re-scrape.
 */
export function shouldSkipCachedHandle(
  cached: CachedMeasurement | undefined,
  range: FollowerRange,
  now: Date = new Date(),
  ttlDays: number = REJECT_CACHE_TTL_DAYS,
): boolean {
  if (!cached) return false;
  if (!Number.isFinite(cached.followerCount)) return false;
  // Back inside the band means re-admit, whichever side it was cached on.
  if (cached.followerCount >= range.min && cached.followerCount <= range.max) return false;

  const measured = new Date(cached.measuredAt).getTime();
  if (Number.isNaN(measured)) return false;

  const ageDays = (now.getTime() - measured) / 86_400_000;
  return ageDays <= ttlDays;
}

/**
 * Most recent measurement per handle, from a list of rows for those handles.
 *
 * The unique key is (run_id, platform, handle), so a handle seen across three
 * runs has three rows. The cache wants the latest reading; the older ones are
 * history the funnel query still needs.
 */
export function latestMeasurements(
  rows: { platform: string; handle: string; follower_count: number | null; measured_at: string | null }[],
): Map<string, CachedMeasurement> {
  const latest = new Map<string, CachedMeasurement>();

  for (const row of rows) {
    if (row.follower_count === null || row.measured_at === null) continue;
    const key = `${row.platform}|${norm(row.handle)}`;
    const existing = latest.get(key);
    if (existing && new Date(existing.measuredAt) >= new Date(row.measured_at)) continue;
    latest.set(key, {
      platform: row.platform,
      handle: norm(row.handle),
      followerCount: row.follower_count,
      measuredAt: row.measured_at,
    });
  }

  return latest;
}

export const cacheKey = (platform: string, handle: string) => `${platform}|${norm(handle)}`;
