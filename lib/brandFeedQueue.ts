import { supabase } from './supabase';
import { fetchAllRows } from './supabasePaging';
import { DEFAULT_CASTING_SAMPLE_FLOOR } from './castingProfile';
import {
  buildBrandFeedSources,
  poolForScope,
  queueFromPool,
  type AliasRow,
  type BrandRow,
  type BrandFeedPlatform,
  type BrandFeedScope,
  type BrandFeedOrder,
  type BrandFeedCandidate,
  type BrandFeedSources,
  type BrandFeedQueue,
} from './brandFeedQueueCore';

/**
 * Brand-feed queue construction — the database half.
 *
 * Reads brand_aliases and brands (both paged: the tables exceed the 5,500-row
 * read cap) and hands them to lib/brandFeedQueueCore.ts, which owns the join,
 * the pool and the ordering and is what the tests exercise.
 *
 * brand_aliases is queried live on every call, so brands classified after
 * today automatically enter the pool. Nothing is snapshotted or hardcoded.
 */

export {
  BRAND_FEED_PLATFORMS,
  poolForScope,
  applyOrder,
  type BrandFeedPlatform,
  type BrandFeedScope,
  type BrandFeedOrder,
  type BrandFeedCandidate,
  type BrandFeedSources,
  type BrandFeedQueue,
} from './brandFeedQueueCore';

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
        'id, instagram_handle, tiktok_handle, mention_platforms, ' +
        'feed_scraped_at, feed_post_count, tiktok_feed_scraped_at, tiktok_feed_post_count, ' +
        'casting_in_range_count, casting_sample_size, total_partnerships_detected'
      )
      .order('id', { ascending: true })
  );
}

export async function loadBrandFeedSources(): Promise<BrandFeedSources> {
  const [aliases, brands] = await Promise.all([loadAliases(), loadBrands()]);
  return buildBrandFeedSources(aliases, brands);
}

export async function loadBrandFeedPool(
  scope: BrandFeedScope,
  platform: BrandFeedPlatform = 'instagram'
): Promise<BrandFeedCandidate[]> {
  return poolForScope(await loadBrandFeedSources(), scope, platform);
}

export async function buildBrandFeedQueue(
  scope: BrandFeedScope,
  order: BrandFeedOrder,
  batchSize: number,
  minLastPostCount?: number,
  castingSampleFloor: number = DEFAULT_CASTING_SAMPLE_FLOOR,
  platform: BrandFeedPlatform = 'instagram'
): Promise<BrandFeedQueue> {
  const pool = await loadBrandFeedPool(scope, platform);
  return queueFromPool(pool, order, batchSize, minLastPostCount, castingSampleFloor);
}
