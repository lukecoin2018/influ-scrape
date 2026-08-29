import { supabase } from './supabase';
import { looseHandle as norm } from './handles';
import {
  latestMeasurements,
  type CachedMeasurement,
  type CandidateOutcome,
} from './discoveryCache';

/**
 * Discovery run records and the candidate log / reject cache — database access.
 *
 * The cache semantics live in discoveryCache.ts, which imports no client and is
 * therefore unit-testable. This module is the thin part that talks to Postgres.
 *
 * The candidate log answers two questions that were previously unanswerable.
 * discovery_runs stores only counts, so "how much of the discarded 80% was
 * already known, versus genuinely out of band" could not be reconstructed —
 * and neither could "have we paid to scrape this handle before".
 */

export * from './discoveryCache';

/** PostgREST `in.()` lists go in the URL; keep them well short of URL limits. */
const LOOKUP_CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Prior measurements for these handles, latest per handle. */
export async function loadCachedMeasurements(
  handles: string[],
  platform: string,
): Promise<Map<string, CachedMeasurement>> {
  if (handles.length === 0) return new Map();

  const rows: { platform: string; handle: string; follower_count: number | null; measured_at: string | null }[] = [];

  for (const batch of chunk(handles, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from('discovery_candidates')
      .select('platform, handle, follower_count, measured_at')
      .eq('platform', platform)
      .in('handle', batch)
      .not('measured_at', 'is', null);

    if (error) throw new Error(`discovery_candidates lookup failed: ${error.message}`);
    rows.push(...(data || []));
  }

  return latestMeasurements(rows);
}

/** Handles already present in ANY population, so no scrape is needed. */
export async function loadKnownHandles(
  handles: string[],
  platform: string,
): Promise<Set<string>> {
  const known = new Set<string>();
  if (handles.length === 0) return known;

  for (const batch of chunk(handles, LOOKUP_CHUNK)) {
    // v_social_profiles_all, not social_profiles: an out-of-range creator lives
    // in the archive, and looking only at the live table would re-scrape them
    // on every run.
    const { data, error } = await supabase
      .from('v_social_profiles_all')
      .select('handle')
      .eq('platform', platform)
      .in('handle', batch);

    if (error) throw new Error(`known-handle lookup failed: ${error.message}`);
    for (const row of data || []) known.add(String(row.handle).toLowerCase());
  }

  return known;
}

export interface CandidateRow {
  handle: string;
  outcome: CandidateOutcome;
  /** From a profile scrape. Omitted until one returns a reading. */
  followerCount?: number | null;
  /**
   * From the search item's author metadata — free, no profile scrape.
   * Recorded for every candidate that carried one, whatever happened next.
   */
  authorFollowerCount?: number | null;
  authorTtSeller?: boolean | null;
  authorSignature?: string | null;
  authorVerified?: boolean | null;
}

/**
 * Writes candidate rows for one search term.
 *
 * Called twice per hashtag: once before the profile scrape with every
 * candidate and no follower counts, then again afterwards for the handles that
 * were measured. The second call upserts on (run_id, platform, handle), so the
 * pre-scrape row is updated in place rather than duplicated.
 *
 * measured_at is set if and only if a follower count is present — the pairing
 * the table's CHECK constraint enforces.
 */
export async function writeCandidates(
  runId: string,
  hashtag: string,
  platform: string,
  rows: CandidateRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const now = new Date().toISOString();
  const payload = rows.map(row => {
    const scraped = typeof row.followerCount === 'number' && Number.isFinite(row.followerCount);
    const fromSearch = typeof row.authorFollowerCount === 'number'
      && Number.isFinite(row.authorFollowerCount);

    // Both are real measurements; one cost $0.005 and one was free. The reject
    // cache reads follower_count, so a free reading has to land there too or a
    // handle rejected before scraping would be re-scraped on every future run.
    // follower_count_source is what keeps the two distinguishable.
    const followerCount = scraped ? row.followerCount! : fromSearch ? row.authorFollowerCount! : null;
    const source = scraped ? 'profile_scrape' : fromSearch ? 'search_item' : null;

    return {
      run_id: runId,
      hashtag,
      platform,
      handle: norm(row.handle),
      outcome: row.outcome,
      follower_count: followerCount,
      measured_at: followerCount === null ? null : now,
      follower_count_source: source,
      author_ttseller: row.authorTtSeller ?? null,
      author_signature: row.authorSignature ?? null,
      author_verified: row.authorVerified ?? null,
    };
  });

  let written = 0;
  for (const batch of chunk(payload, LOOKUP_CHUNK)) {
    const { error } = await supabase
      .from('discovery_candidates')
      .upsert(batch, { onConflict: 'run_id,platform,handle' });

    if (error) throw new Error(`discovery_candidates write failed: ${error.message}`);
    written += batch.length;
  }

  return written;
}

/**
 * Advances last_progress_at.
 *
 * This is what makes an abandoned run identifiable: a run still marked
 * 'running' that has been silent longer than a live one plausibly could be.
 * Failure is logged, not thrown — losing a heartbeat must not fail a hashtag
 * whose scrape has already been paid for.
 */
export async function touchRun(runId: string): Promise<void> {
  const { error } = await supabase
    .from('discovery_runs')
    .update({ last_progress_at: new Date().toISOString() })
    .eq('id', runId);

  if (error) console.error(`Failed to touch run ${runId}:`, error.message);
}
