import { supabase } from './supabase';

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
  const { data: profiles } = await supabase
    .from('social_profiles')
    .select('creator_id, intelligence_updated_at')
    .not('intelligence_updated_at', 'is', null);

  const maxIntelByCreator = new Map<string, number>();
  for (const p of profiles || []) {
    const t = new Date(p.intelligence_updated_at as string).getTime();
    const creatorId = p.creator_id as string;
    const current = maxIntelByCreator.get(creatorId);
    if (current === undefined || t > current) {
      maxIntelByCreator.set(creatorId, t);
    }
  }

  const { data: creators } = await supabase
    .from('creators')
    .select('id, display_name, embedded_at')
    .not('embedded_at', 'is', null);

  return (creators || [])
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
