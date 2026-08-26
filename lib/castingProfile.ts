import { supabase } from './supabase';
import { fetchAllRows } from './supabasePaging';
import {
  DEFAULT_MIN_FOLLOWERS,
  DEFAULT_MAX_FOLLOWERS,
  type FollowerRange,
} from './followerRange';

/**
 * Per-brand casting profile: of the creators a brand has partnered with,
 * how many sit below, inside and above a follower band.
 *
 * Computed from partnerships.creator_follower_count — the count snapshotted
 * when the edge was written — never from the creator's current count. That is
 * what keeps the profile stable: it is a pure function of the edges, so it
 * cannot drift as creators grow, and it answers "who did this brand cast"
 * rather than "what do this brand's past partners look like today".
 */

/**
 * A brand's casting behaviour changes over time, so counts are windowed.
 *
 * 365 days rather than something shorter: 91% of current edges fall inside 90
 * days, but that reflects the brand-feed scraper reading recent posts, not
 * brands being more active lately. A 90-day window would mostly measure what
 * the last scrape happened to see.
 */
export const DEFAULT_CASTING_WINDOW_DAYS = 365;

/** Below this many distinct creators, a rate is noise rather than signal. */
export const DEFAULT_CASTING_SAMPLE_FLOOR = 5;

export interface CastingCounts {
  inRange: number;
  below: number;
  above: number;
  /** Creators whose snapshot is missing or zero — a failed or private scrape. */
  unknown: number;
  /** Distinct creators in the window. The denominator. */
  sampleSize: number;
}

export interface CastingProfile extends CastingCounts {
  windowDays: number;
  minFollowers: number;
  maxFollowers: number;
}

/** One partnership edge, reduced to what classification needs. */
export interface CastingEdge {
  creator_id: string;
  creator_follower_count: number | null;
  /** Falls back to detected_at when the post carried no date. */
  posted_at: string | null;
  detected_at?: string | null;
}

const EMPTY: CastingCounts = { inRange: 0, below: 0, above: 0, unknown: 0, sampleSize: 0 };

function edgeDate(edge: CastingEdge): number | null {
  const raw = edge.posted_at ?? edge.detected_at ?? null;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Classifies a brand's edges into band counts.
 *
 * Counts distinct CREATORS, not edges: a brand with twelve posts featuring
 * three creators has cast three people, and edge-counting would let one
 * heavily-posted collaboration dominate the profile.
 *
 * When a creator appears on several edges, the most recent one wins — that
 * snapshot best represents how the brand casts now.
 *
 * Pure and dependency-free so it can be tested directly.
 */
export function classifyCastingEdges(
  edges: CastingEdge[],
  range: FollowerRange,
  windowDays: number,
  now: number = Date.now()
): CastingCounts {
  if (edges.length === 0) return { ...EMPTY };

  const cutoff = now - windowDays * 86_400_000;

  // Most recent snapshot per creator, inside the window.
  const latest = new Map<string, { at: number; followers: number | null }>();

  for (const edge of edges) {
    const at = edgeDate(edge);
    // An undateable edge cannot be shown to be recent, so it is excluded
    // rather than silently counted as in-window.
    if (at === null || at < cutoff) continue;

    const current = latest.get(edge.creator_id);
    if (!current || at > current.at) {
      latest.set(edge.creator_id, { at, followers: edge.creator_follower_count });
    }
  }

  const counts: CastingCounts = { ...EMPTY, sampleSize: latest.size };

  for (const { followers } of latest.values()) {
    if (followers === null || followers === undefined || followers <= 0) counts.unknown++;
    else if (followers < range.min) counts.below++;
    else if (followers > range.max) counts.above++;
    else counts.inRange++;
  }

  return counts;
}

/** In-band share of the creators we could classify. Null below the floor. */
export function castingRate(
  counts: CastingCounts,
  sampleFloor: number = DEFAULT_CASTING_SAMPLE_FLOOR
): number | null {
  const classified = counts.inRange + counts.below + counts.above;
  if (counts.sampleSize < sampleFloor || classified === 0) return null;
  return counts.inRange / classified;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export interface CastingOptions {
  range?: FollowerRange;
  windowDays?: number;
}

function resolveOptions(options: CastingOptions = {}) {
  return {
    range: options.range ?? { min: DEFAULT_MIN_FOLLOWERS, max: DEFAULT_MAX_FOLLOWERS },
    windowDays: options.windowDays ?? DEFAULT_CASTING_WINDOW_DAYS,
  };
}

function toRow(counts: CastingCounts, range: FollowerRange, windowDays: number) {
  return {
    casting_in_range_count: counts.inRange,
    casting_below_count: counts.below,
    casting_above_count: counts.above,
    casting_unknown_count: counts.unknown,
    casting_sample_size: counts.sampleSize,
    casting_computed_at: new Date().toISOString(),
    // Stored with every write: the counts are uninterpretable without them.
    casting_window_days: windowDays,
    casting_min_followers: range.min,
    casting_max_followers: range.max,
  };
}

/**
 * Recomputes and stores one brand's casting profile.
 *
 * Writes ONLY casting_* columns. It never touches
 * total_partnerships_detected, avg/min/max_partner_follower_count,
 * preferred_creator_tier or active_niches, and never calls
 * recalculate_brand_stats() — that RPC rebuilds those from the partnerships
 * table and would replace enrich-built counters with feed-derived ones.
 */
export async function recomputeCastingProfile(
  brandId: string,
  options: CastingOptions = {}
): Promise<CastingProfile> {
  const { range, windowDays } = resolveOptions(options);

  const { data, error } = await supabase
    .from('partnerships')
    .select('creator_id, creator_follower_count, posted_at, detected_at')
    .eq('brand_id', brandId);

  if (error) throw new Error(`Failed to load partnerships for ${brandId}: ${error.message}`);

  const counts = classifyCastingEdges((data || []) as CastingEdge[], range, windowDays);

  const { error: updateError } = await supabase
    .from('brands')
    .update(toRow(counts, range, windowDays))
    .eq('id', brandId);

  if (updateError) {
    throw new Error(`Failed to store casting profile for ${brandId}: ${updateError.message}`);
  }

  return { ...counts, windowDays, minFollowers: range.min, maxFollowers: range.max };
}

/**
 * Recomputes every brand that has at least one partnership edge.
 *
 * Reads all edges once and groups in memory rather than issuing a query per
 * brand — the whole table is small and this keeps a full rebuild to a handful
 * of round trips. Brands with no edges are left untouched: a NULL profile is
 * "not computed", which is different from a computed zero.
 */
export async function recomputeAllCastingProfiles(
  options: CastingOptions = {}
): Promise<{ brandsUpdated: number; edgesConsidered: number }> {
  const { range, windowDays } = resolveOptions(options);

  const edges = await fetchAllRows<CastingEdge & { brand_id: string }>(() =>
    supabase
      .from('partnerships')
      .select('brand_id, creator_id, creator_follower_count, posted_at, detected_at')
      .order('id', { ascending: true })
  );

  const byBrand = new Map<string, CastingEdge[]>();
  for (const edge of edges) {
    if (!edge.brand_id) continue;
    const list = byBrand.get(edge.brand_id);
    if (list) list.push(edge);
    else byBrand.set(edge.brand_id, [edge]);
  }

  let brandsUpdated = 0;
  for (const [brandId, brandEdges] of byBrand) {
    const counts = classifyCastingEdges(brandEdges, range, windowDays);
    const { error } = await supabase
      .from('brands')
      .update(toRow(counts, range, windowDays))
      .eq('id', brandId);

    if (error) console.error(`Failed to store casting profile for ${brandId}:`, error.message);
    else brandsUpdated++;
  }

  return { brandsUpdated, edgesConsidered: edges.length };
}
