import { supabase } from './supabase';
import { fetchAllRows } from './supabasePaging';

export interface CreatorNeedingReembedding {
  id: string;
  displayName: string | null;
  intelligenceUpdatedAt: string;
}

/**
 * Creators whose most-recent intelligence_updated_at (across all their
 * social_profiles, joined via creator_id) is newer than their embedded_at.
 * Creators with a NULL embedded_at are excluded — they're covered by
 * "Not yet embedded" instead, and shouldn't be double-counted here.
 *
 * PostgREST can't express "MAX(social_profiles.intelligence_updated_at) >
 * creators.embedded_at" as a single filter — it's a cross-table, aggregated
 * column-to-column comparison. So this fetches both sides and compares in
 * JS, the same approach used for the Enrich page's stale_first mode and the
 * Intelligence page's needs_reanalysis mode.
 *
 * Returned sorted descending by each creator's most recent
 * intelligence_updated_at (most recently re-analyzed first).
 */
export async function getCreatorsNeedingReembedding(): Promise<CreatorNeedingReembedding[]> {
  // Both sides need their rows: this computes MAX(intelligence_updated_at)
  // per creator and compares it against creators.embedded_at, a
  // cross-table aggregated column-to-column comparison PostgREST cannot
  // express. Paged rather than capped — a plain select stops at 50,000 rows
  // and gives no indication that it truncated, which would silently shrink
  // the stale set as the table grows.
  const profiles = await fetchAllRows<{ creator_id: string; intelligence_updated_at: string }>(() => supabase
    .from('social_profiles')
    .select('creator_id, intelligence_updated_at')
    .eq('import_status', 'active')
    .not('intelligence_updated_at', 'is', null)
    .order('id', { ascending: true }));

  const maxIntelByCreator = new Map<string, number>();
  for (const p of profiles) {
    const t = new Date(p.intelligence_updated_at as string).getTime();
    const creatorId = p.creator_id as string;
    const current = maxIntelByCreator.get(creatorId);
    if (current === undefined || t > current) {
      maxIntelByCreator.set(creatorId, t);
    }
  }

  const creators = await fetchAllRows<{ id: string; display_name: string | null; embedded_at: string }>(() => supabase
    .from('creators')
    .select('id, display_name, embedded_at')
    .eq('import_status', 'active')
    .not('embedded_at', 'is', null)
    .order('id', { ascending: true }));

  return creators
    .map((c) => {
      const id = c.id as string;
      return {
        id,
        displayName: (c.display_name as string | null) ?? null,
        embeddedAt: new Date(c.embedded_at as string).getTime(),
        maxIntel: maxIntelByCreator.get(id),
      };
    })
    .filter((c) => c.maxIntel !== undefined && c.maxIntel > c.embeddedAt)
    .sort((a, b) => (b.maxIntel as number) - (a.maxIntel as number))
    .map((c) => ({
      id: c.id,
      displayName: c.displayName,
      intelligenceUpdatedAt: new Date(c.maxIntel as number).toISOString(),
    }));
}
