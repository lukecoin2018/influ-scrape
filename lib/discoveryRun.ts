import { supabase } from './supabase';
import { latestMeasurements, type CachedMeasurement } from './discoveryCache';

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
