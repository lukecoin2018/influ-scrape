import { supabase } from './supabase';
import { fetchAllRows } from './supabasePaging';
import { DEFAULT_CASTING_SAMPLE_FLOOR } from './castingProfile';

/**
 * Brand-feed queue construction.
 *
 * Scope (which brands are eligible) and ordering (which of them go first) are
 * independent and compose freely — a quality gate is not baked into a sort.
 *
 * brand_aliases is queried live on every call, so brands classified after
 * today automatically enter the pool. Nothing is snapshotted or hardcoded.
 *
 * There is no foreign key between brand_aliases and brands; the relationship
 * is lower(brand_aliases.alias) = lower(brands.instagram_handle). PostgREST
 * cannot express that join, so both sides are read and joined here. Both
 * tables exceed the 5,500-row read cap territory, hence fetchAllRows().
 */

export type BrandFeedScope = 'verified_brands' | 'classified_brands' | 'all_brands';
export type BrandFeedOrder = 'never_scraped' | 'stale_first' | 'top_creators' | 'casting_fit';

export interface BrandFeedCandidate {
  handle: string;
  /** null = a classified alias with no brands row yet (orphan). */
  brandId: string | null;
  feedScrapedAt: string | null;
  /** brand_aliases.creators_count — null when the handle has no alias row. */
  creatorsCount: number | null;
  /** Posts the last scrape returned. null = not scraped since the column existed. */
  feedPostCount: number | null;
  /** Partnered creators inside the band, from the stored casting profile. */
  castingInRange: number | null;
  /** Distinct partnered creators the profile was computed over. */
  castingSampleSize: number | null;
  aliasVerified: boolean;
  isClassifiedBrand: boolean;
  totalPartnershipsDetected: number;
}

interface AliasRow {
  alias: string;
  verified: boolean | null;
  creators_count: number | null;
}

interface BrandRow {
  id: string;
  instagram_handle: string | null;
  feed_scraped_at: string | null;
  feed_post_count: number | null;
  casting_in_range_count: number | null;
  casting_sample_size: number | null;
  total_partnerships_detected: number | null;
}

const norm = (value: string | null | undefined) =>
  (value || '').trim().toLowerCase().replace(/^@/, '');

// ── Pool ──────────────────────────────────────────────────────────────────────

async function loadAliases(): Promise<AliasRow[]> {
  return fetchAllRows<AliasRow>(() =>
    supabase
      .from('brand_aliases')
      .select('alias, verified, creators_count')
      .eq('entity_type', 'brand')
      .order('alias', { ascending: true })
  );
}

async function loadBrands(): Promise<BrandRow[]> {
  return fetchAllRows<BrandRow>(() =>
    supabase
      .from('brands')
      .select(
        'id, instagram_handle, feed_scraped_at, feed_post_count, ' +
        'casting_in_range_count, casting_sample_size, total_partnerships_detected'
      )
      .order('id', { ascending: true })
  );
}

/**
 * The two tables the pool is derived from, read once and keyed by handle.
 *
 * Split out from loadBrandFeedPool() so the status route can size all three
 * scopes from a single read — otherwise one page load would pull ~44k rows
 * (2,795 aliases + 11,856 brands, three times over).
 */
export interface BrandFeedSources {
  aliasByHandle: Map<string, AliasRow>;
  brandByHandle: Map<string, BrandRow>;
}

export async function loadBrandFeedSources(): Promise<BrandFeedSources> {
  const [aliases, brands] = await Promise.all([loadAliases(), loadBrands()]);

  const aliasByHandle = new Map<string, AliasRow>();
  for (const alias of aliases) {
    const handle = norm(alias.alias);
    if (handle) aliasByHandle.set(handle, alias);
  }

  const brandByHandle = new Map<string, BrandRow>();
  for (const brand of brands) {
    const handle = norm(brand.instagram_handle);
    if (!handle) continue;
    // Case-variant duplicates collapse here. Keep whichever row has already
    // been feed-scraped so we don't re-scrape a handle we've covered.
    const existing = brandByHandle.get(handle);
    if (!existing || (!existing.feed_scraped_at && brand.feed_scraped_at)) {
      brandByHandle.set(handle, brand);
    }
  }

  return { aliasByHandle, brandByHandle };
}

/**
 * Builds the full eligible pool for a scope, before ordering or slicing.
 *
 * For the alias-backed scopes the alias list drives the pool, so classified
 * brands with no brands row still appear — with brandId null. The process
 * route creates the stub row for those when it runs them (partnerships.brand_id
 * is NOT NULL, so an edge cannot be recorded without one).
 */
export function poolForScope(
  sources: BrandFeedSources,
  scope: BrandFeedScope
): BrandFeedCandidate[] {
  const { aliasByHandle, brandByHandle } = sources;

  const toCandidate = (handle: string): BrandFeedCandidate => {
    const alias = aliasByHandle.get(handle);
    const brand = brandByHandle.get(handle);
    return {
      handle,
      brandId: brand?.id ?? null,
      feedScrapedAt: brand?.feed_scraped_at ?? null,
      feedPostCount: brand?.feed_post_count ?? null,
      castingInRange: brand?.casting_in_range_count ?? null,
      castingSampleSize: brand?.casting_sample_size ?? null,
      creatorsCount: alias?.creators_count ?? null,
      aliasVerified: alias?.verified === true,
      isClassifiedBrand: alias !== undefined,
      totalPartnershipsDetected: brand?.total_partnerships_detected ?? 0,
    };
  };

  if (scope === 'all_brands') {
    return Array.from(brandByHandle.keys()).map(toCandidate);
  }

  return Array.from(aliasByHandle.entries())
    .filter(([, alias]) => scope === 'classified_brands' || alias.verified === true)
    .map(([handle]) => handle)
    .map(toCandidate);
}

export async function loadBrandFeedPool(scope: BrandFeedScope): Promise<BrandFeedCandidate[]> {
  return poolForScope(await loadBrandFeedSources(), scope);
}

// ── Ordering ──────────────────────────────────────────────────────────────────

/**
 * "How many creators point at this brand", used by the top_creators ordering.
 *
 * brand_aliases.creators_count is the real signal but only exists for
 * classified handles. Under the all_brands scope, unclassified brands fall
 * back to total_partnerships_detected, which counts the same thing from the
 * other direction (enrich-pipeline increments per creator mention).
 */
const interestScore = (c: BrandFeedCandidate) =>
  c.creatorsCount ?? c.totalPartnershipsDetected ?? 0;

const byHandle = (a: BrandFeedCandidate, b: BrandFeedCandidate) =>
  a.handle.localeCompare(b.handle);

export /**
 * Ranks by the share of a brand's partnered creators that fall inside the band.
 *
 * Rate, not absolute count: the queue decides which brands are worth a scrape,
 * and rate predicts yield per scrape while a raw count mostly tracks brand
 * size. 9 in-band out of 50 is a worse target than 6 out of 7, even though the
 * count is higher.
 *
 * The rate is derived here from the stored raw counts rather than being
 * persisted, so changing the floor never requires recomputing anything — and
 * a brand that is 100% in-band across 4 creators cannot float to the top on a
 * number that means nothing. Brands under the floor are not dropped; they sort
 * after every brand that clears it, so a thin sample delays a brand rather
 * than hiding it.
 *
 * Unknown snapshots stay in the denominator: a creator whose follower count we
 * could not read is not evidence of a good fit.
 */
function byCastingFit(sampleFloor: number) {
  const rank = (c: BrandFeedCandidate) => {
    const sample = c.castingSampleSize ?? 0;
    if (sample < sampleFloor) return -1;
    return (c.castingInRange ?? 0) / sample;
  };
  return (a: BrandFeedCandidate, b: BrandFeedCandidate) => {
    const diff = rank(b) - rank(a);
    if (diff !== 0) return diff;
    // Same rate: more in-band creators is the stronger signal.
    return (b.castingInRange ?? 0) - (a.castingInRange ?? 0)
      || (b.castingSampleSize ?? 0) - (a.castingSampleSize ?? 0)
      || byHandle(a, b);
  };
}

export function applyOrder(
  pool: BrandFeedCandidate[],
  order: BrandFeedOrder,
  sampleFloor: number = DEFAULT_CASTING_SAMPLE_FLOOR
): BrandFeedCandidate[] {
  const rows = [...pool];

  if (order === 'casting_fit') return rows.sort(byCastingFit(sampleFloor));

  if (order === 'never_scraped') {
    return rows
      .filter(c => c.feedScrapedAt === null)
      .sort((a, b) => interestScore(b) - interestScore(a) || byHandle(a, b));
  }

  if (order === 'stale_first') {
    // NULLS FIRST: never-scraped is maximally stale.
    return rows.sort((a, b) => {
      if (a.feedScrapedAt === null && b.feedScrapedAt === null) {
        return interestScore(b) - interestScore(a) || byHandle(a, b);
      }
      if (a.feedScrapedAt === null) return -1;
      if (b.feedScrapedAt === null) return 1;
      return a.feedScrapedAt.localeCompare(b.feedScrapedAt) || byHandle(a, b);
    });
  }

  return rows.sort((a, b) => interestScore(b) - interestScore(a) || byHandle(a, b));
}

export interface BrandFeedQueue {
  items: BrandFeedCandidate[];
  poolSize: number;
  /** Brands dropped by the optional low-yield filter. */
  lowYieldSkipped: number;
  neverScrapedInQueue: number;
  rescrapesInQueue: number;
  orphansInQueue: number;
}

export async function buildBrandFeedQueue(
  scope: BrandFeedScope,
  order: BrandFeedOrder,
  batchSize: number,
  /**
   * Optional low-yield filter. Drops brands whose LAST scrape returned fewer
   * than this many posts — the dormant/renamed-handle signal. Opt-in only:
   * a brand can have a quiet period, so nothing excludes on this by default.
   * Brands never scraped (null count) are always kept; absence of evidence
   * is not evidence of a dead handle.
   */
  minLastPostCount?: number,
  castingSampleFloor: number = DEFAULT_CASTING_SAMPLE_FLOOR
): Promise<BrandFeedQueue> {
  const pool = await loadBrandFeedPool(scope);

  const eligible = typeof minLastPostCount === 'number' && minLastPostCount > 0
    ? pool.filter(c => c.feedPostCount === null || c.feedPostCount >= minLastPostCount)
    : pool;

  const ordered = applyOrder(eligible, order, castingSampleFloor);
  const items = ordered.slice(0, Math.max(0, batchSize));

  return {
    items,
    poolSize: ordered.length,
    lowYieldSkipped: pool.length - eligible.length,
    neverScrapedInQueue: items.filter(i => i.feedScrapedAt === null).length,
    rescrapesInQueue: items.filter(i => i.feedScrapedAt !== null).length,
    orphansInQueue: items.filter(i => i.brandId === null).length,
  };
}
