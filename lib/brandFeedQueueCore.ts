/**
 * Brand-feed queue construction — the pure half.
 *
 * Pool selection and ordering over rows already read from the database. No
 * client import, so unit tests can load it (deferred-cleanups item 9: modules
 * tests need must not import ./supabase). lib/brandFeedQueue.ts owns the
 * reads and re-exports everything here.
 *
 * Scope (which brands are eligible) and ordering (which of them go first) are
 * independent and compose freely — a quality gate is not baked into a sort.
 *
 * There is no foreign key between brand_aliases and brands; the relationship
 * is lower(brand_aliases.alias) = lower(brands.instagram_handle). PostgREST
 * cannot express that join, so both sides are read and joined here.
 *
 * PLATFORM. The pool is built once from the alias/brand join and then, for
 * TikTok, narrowed to brands whose mention_platforms contains 'tiktok' — the
 * filter 20260826000006 described and the Instagram queue never applied. The
 * scrape stamp the ordering reads (feedScrapedAt / feedPostCount) is the
 * platform's own pair, so "never scraped on TikTok" is independent of the
 * Instagram stamp. An alias with no brands row (an orphan) can carry no
 * mention_platforms and so never enters the TikTok pool: a TikTok-only brand
 * is eligible only through the flag, never through an unmatched alias.
 *
 * The TikTok candidate's handle is brands.tiktok_handle. Today that is
 * byte-identical to instagram_handle on every row (the enrich pipeline writes
 * the same caption token into both), but the process route resolves the row
 * by tiktok_handle first, so the queue hands over the column that lookup is
 * keyed on.
 */

export type BrandFeedPlatform = 'instagram' | 'tiktok';
export type BrandFeedScope = 'verified_brands' | 'classified_brands' | 'all_brands';
export type BrandFeedOrder = 'never_scraped' | 'stale_first' | 'top_creators' | 'casting_fit';

export const BRAND_FEED_PLATFORMS: BrandFeedPlatform[] = ['instagram', 'tiktok'];

export interface BrandFeedCandidate {
  handle: string;
  /** null = a classified alias with no brands row yet (orphan). */
  brandId: string | null;
  /** The selected platform's scrape stamp. */
  feedScrapedAt: string | null;
  /** brand_aliases.creators_count — null when the handle has no alias row. */
  creatorsCount: number | null;
  /** Posts the platform's last scrape returned. null = not scraped since the column existed. */
  feedPostCount: number | null;
  /** Partnered creators inside the band, from the stored casting profile. */
  castingInRange: number | null;
  /** Distinct partnered creators the profile was computed over. */
  castingSampleSize: number | null;
  aliasVerified: boolean;
  isClassifiedBrand: boolean;
  totalPartnershipsDetected: number;
}

export interface AliasRow {
  alias: string;
  verified: boolean | null;
  creators_count: number | null;
}

export interface BrandRow {
  id: string;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  mention_platforms: string[] | null;
  feed_scraped_at: string | null;
  feed_post_count: number | null;
  tiktok_feed_scraped_at: string | null;
  tiktok_feed_post_count: number | null;
  casting_in_range_count: number | null;
  casting_sample_size: number | null;
  total_partnerships_detected: number | null;
}

export const norm = (value: string | null | undefined) =>
  (value || '').trim().toLowerCase().replace(/^@/, '');

/**
 * The two tables the pool is derived from, read once and keyed by handle.
 *
 * Split out so the status route can size every scope from a single read —
 * otherwise one page load would pull ~44k rows (aliases + brands, three times
 * over, and now for two platforms).
 */
export interface BrandFeedSources {
  aliasByHandle: Map<string, AliasRow>;
  brandByHandle: Map<string, BrandRow>;
}

export function buildBrandFeedSources(aliases: AliasRow[], brands: BrandRow[]): BrandFeedSources {
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

/** Does this brands row carry the platform's mention flag? */
export function brandIsOnPlatform(brand: BrandRow | undefined, platform: BrandFeedPlatform): boolean {
  if (platform === 'instagram') return true;
  return Array.isArray(brand?.mention_platforms) && brand.mention_platforms.includes('tiktok');
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
  scope: BrandFeedScope,
  platform: BrandFeedPlatform = 'instagram'
): BrandFeedCandidate[] {
  const { aliasByHandle, brandByHandle } = sources;

  const toCandidate = (handle: string): BrandFeedCandidate => {
    const alias = aliasByHandle.get(handle);
    const brand = brandByHandle.get(handle);
    const tiktok = platform === 'tiktok';
    return {
      handle: tiktok ? (norm(brand?.tiktok_handle) || handle) : handle,
      brandId: brand?.id ?? null,
      feedScrapedAt: (tiktok ? brand?.tiktok_feed_scraped_at : brand?.feed_scraped_at) ?? null,
      feedPostCount: (tiktok ? brand?.tiktok_feed_post_count : brand?.feed_post_count) ?? null,
      castingInRange: brand?.casting_in_range_count ?? null,
      castingSampleSize: brand?.casting_sample_size ?? null,
      creatorsCount: alias?.creators_count ?? null,
      aliasVerified: alias?.verified === true,
      isClassifiedBrand: alias !== undefined,
      totalPartnershipsDetected: brand?.total_partnerships_detected ?? 0,
    };
  };

  const onPlatform = (handle: string) => brandIsOnPlatform(brandByHandle.get(handle), platform);

  if (scope === 'all_brands') {
    return Array.from(brandByHandle.keys()).filter(onPlatform).map(toCandidate);
  }

  return Array.from(aliasByHandle.entries())
    .filter(([, alias]) => scope === 'classified_brands' || alias.verified === true)
    .map(([handle]) => handle)
    .filter(onPlatform)
    .map(toCandidate);
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

/**
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
  sampleFloor: number
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

/**
 * Filters, orders and slices an already-built pool.
 *
 * minLastPostCount: optional low-yield filter. Drops brands whose LAST scrape
 * on this platform returned fewer than this many posts — the dormant /
 * renamed-handle signal. Opt-in only: a brand can have a quiet period, so
 * nothing excludes on this by default. Brands never scraped (null count) are
 * always kept; absence of evidence is not evidence of a dead handle.
 */
export function queueFromPool(
  pool: BrandFeedCandidate[],
  order: BrandFeedOrder,
  batchSize: number,
  minLastPostCount: number | undefined,
  castingSampleFloor: number
): BrandFeedQueue {
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
