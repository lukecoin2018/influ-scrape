import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBrandFeedSources,
  poolForScope,
  queueFromPool,
  type AliasRow,
  type BrandRow,
} from './brandFeedQueueCore.ts';

const brand = (over: Partial<BrandRow> & { instagram_handle: string }): BrandRow => ({
  id: `id-${over.instagram_handle}`,
  tiktok_handle: null,
  mention_platforms: ['instagram'],
  feed_scraped_at: null,
  feed_post_count: null,
  tiktok_feed_scraped_at: null,
  tiktok_feed_post_count: null,
  casting_in_range_count: null,
  casting_sample_size: null,
  total_partnerships_detected: 0,
  ...over,
});

const alias = (name: string, verified = true, creators = 1): AliasRow =>
  ({ alias: name, verified, creators_count: creators });

// Four brands covering the flag combinations, plus an orphan alias.
//   both      — instagram + tiktok, scraped on Instagram, never on TikTok
//   tt_only   — tiktok only, never scraped anywhere
//   ig_only   — instagram only
//   tt_done   — both, already scraped on TikTok
//   orphan    — a verified alias with no brands row
const sources = buildBrandFeedSources(
  [alias('both'), alias('tt_only'), alias('ig_only'), alias('tt_done', false), alias('orphan')],
  [
    brand({ instagram_handle: 'both', tiktok_handle: 'both', mention_platforms: ['instagram', 'tiktok'],
            feed_scraped_at: '2026-08-25T00:00:00Z', feed_post_count: 12 }),
    brand({ instagram_handle: 'tt_only', tiktok_handle: 'tt_only', mention_platforms: ['tiktok'] }),
    brand({ instagram_handle: 'ig_only' }),
    brand({ instagram_handle: 'tt_done', tiktok_handle: 'tt_done', mention_platforms: ['instagram', 'tiktok'],
            tiktok_feed_scraped_at: '2026-09-20T00:00:00Z', tiktok_feed_post_count: 1 }),
  ]
);

const names = (pool: { handle: string }[]) => pool.map(c => c.handle).sort();

// ── Instagram: the pool is unchanged by the platform work ────────────────────

test('instagram verified pool: every verified alias, orphans included, no platform filter', () => {
  const pool = poolForScope(sources, 'verified_brands', 'instagram');
  assert.deepEqual(names(pool), ['both', 'ig_only', 'orphan', 'tt_only']);
  assert.equal(pool.find(c => c.handle === 'orphan')?.brandId, null);
});

test('instagram: the default platform is instagram, so existing callers are unchanged', () => {
  assert.deepEqual(names(poolForScope(sources, 'all_brands')), ['both', 'ig_only', 'tt_done', 'tt_only']);
});

test('instagram candidates read the Instagram stamp pair', () => {
  const both = poolForScope(sources, 'all_brands', 'instagram').find(c => c.handle === 'both');
  assert.equal(both?.feedScrapedAt, '2026-08-25T00:00:00Z');
  assert.equal(both?.feedPostCount, 12);
});

// ── TikTok: existing scopes intersected with mention_platforms ∋ tiktok ──────

test('tiktok verified pool: only brands flagged tiktok; ig_only and the orphan alias drop out', () => {
  const pool = poolForScope(sources, 'verified_brands', 'tiktok');
  assert.deepEqual(names(pool), ['both', 'tt_only']);
});

test('tiktok classified pool adds the unverified flagged brand', () => {
  assert.deepEqual(names(poolForScope(sources, 'classified_brands', 'tiktok')), ['both', 'tt_done', 'tt_only']);
});

test('tiktok all_brands pool is every flagged brands row', () => {
  assert.deepEqual(names(poolForScope(sources, 'all_brands', 'tiktok')), ['both', 'tt_done', 'tt_only']);
});

test('tiktok candidates read the TikTok stamp pair, so an Instagram scrape does not hide a brand', () => {
  const pool = poolForScope(sources, 'all_brands', 'tiktok');
  const both = pool.find(c => c.handle === 'both');
  assert.equal(both?.feedScrapedAt, null, 'scraped on Instagram, never on TikTok');
  assert.equal(both?.feedPostCount, null);
  const done = pool.find(c => c.handle === 'tt_done');
  assert.equal(done?.feedScrapedAt, '2026-09-20T00:00:00Z');
  assert.equal(done?.feedPostCount, 1);
});

test('tiktok candidates carry tiktok_handle, and fall back to the join key when it is null', () => {
  const s = buildBrandFeedSources(
    [alias('named'), alias('bare')],
    [
      brand({ instagram_handle: 'named', tiktok_handle: 'Named.TT', mention_platforms: ['tiktok'] }),
      brand({ instagram_handle: 'bare', tiktok_handle: null, mention_platforms: ['tiktok'] }),
    ]
  );
  assert.deepEqual(names(poolForScope(s, 'verified_brands', 'tiktok')), ['bare', 'named.tt']);
});

// ── Queue: ordering and the low-yield filter act on the platform's stamp ─────

test('never_scraped on tiktok keeps brands scraped only on Instagram and drops the TikTok-scraped one', () => {
  const pool = poolForScope(sources, 'classified_brands', 'tiktok');
  const q = queueFromPool(pool, 'never_scraped', 25, undefined, 5);
  assert.deepEqual(names(q.items), ['both', 'tt_only']);
  assert.equal(q.neverScrapedInQueue, 2);
  assert.equal(q.rescrapesInQueue, 0);
  assert.equal(q.orphansInQueue, 0);
});

test('the low-yield filter reads the TikTok post count on tiktok', () => {
  const pool = poolForScope(sources, 'classified_brands', 'tiktok');
  const q = queueFromPool(pool, 'stale_first', 25, 2, 5);
  assert.deepEqual(names(q.items), ['both', 'tt_only'], 'tt_done returned 1 post on TikTok');
  assert.equal(q.lowYieldSkipped, 1);
});

test('stale_first on tiktok: never-scraped first, then oldest TikTok stamp', () => {
  const pool = poolForScope(sources, 'classified_brands', 'tiktok');
  const q = queueFromPool(pool, 'stale_first', 25, undefined, 5);
  assert.deepEqual(q.items.map(c => c.handle), ['both', 'tt_only', 'tt_done']);
});
