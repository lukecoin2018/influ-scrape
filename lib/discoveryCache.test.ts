import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSkipCachedHandle,
  latestMeasurements,
  cacheKey,
  CANDIDATE_OUTCOMES,
  REJECT_CACHE_TTL_DAYS,
  type CachedMeasurement,
} from './discoveryCache.ts';
import { DEFAULT_MIN_FOLLOWERS, DEFAULT_MAX_FOLLOWERS } from './followerRange.ts';

const BAND = { min: DEFAULT_MIN_FOLLOWERS, max: DEFAULT_MAX_FOLLOWERS };
const NOW = new Date('2026-08-28T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const cached = (followerCount: number, days = 1): CachedMeasurement => ({
  platform: 'instagram', handle: 'h', followerCount, measuredAt: daysAgo(days),
});

test('the taxonomy has the ten values the CHECK constraint lists', () => {
  assert.equal(CANDIDATE_OUTCOMES.length, 10);
  assert.equal(new Set(CANDIDATE_OUTCOMES).size, 10, 'no duplicates');
});

test('the TTL is 90 days, matching the enrichment staleDays default', () => {
  assert.equal(REJECT_CACHE_TTL_DAYS, 90);
});

// ── Skip / re-admit ───────────────────────────────────────────────────────────

test('a handle with no prior measurement is never skipped', () => {
  assert.equal(shouldSkipCachedHandle(undefined, BAND, NOW), false);
});

test('a fresh measurement below the band is skipped', () => {
  assert.equal(shouldSkipCachedHandle(cached(800), BAND, NOW), true);
  assert.equal(shouldSkipCachedHandle(cached(29_999), BAND, NOW), true);
});

test('a measurement inside the band is not skipped', () => {
  assert.equal(shouldSkipCachedHandle(cached(30_000), BAND, NOW), false);
  assert.equal(shouldSkipCachedHandle(cached(100_000), BAND, NOW), false);
});

test('an above-max measurement is not skipped — those are archived, not cached', () => {
  assert.equal(shouldSkipCachedHandle(cached(900_000), BAND, NOW), false);
});

test('lowering the band re-admits a cached handle immediately, with no TTL wait', () => {
  const entry = cached(18_000, 1);

  assert.equal(shouldSkipCachedHandle(entry, { min: 30_000, max: 500_000 }, NOW), true);
  // The comparison is against the CURRENT minimum, so the same row re-enters
  // the moment the band moves — this is the soft-reject semantics.
  assert.equal(shouldSkipCachedHandle(entry, { min: 15_000, max: 500_000 }, NOW), false);
});

test('raising the band starts skipping handles that used to pass', () => {
  const entry = cached(40_000, 1);
  assert.equal(shouldSkipCachedHandle(entry, { min: 30_000, max: 500_000 }, NOW), false);
  assert.equal(shouldSkipCachedHandle(entry, { min: 50_000, max: 500_000 }, NOW), true);
});

test('an expired measurement is re-admitted so the handle is re-scraped', () => {
  assert.equal(shouldSkipCachedHandle(cached(800, 89), BAND, NOW), true);
  assert.equal(shouldSkipCachedHandle(cached(800, 90), BAND, NOW), true, 'exactly at the TTL still skips');
  assert.equal(shouldSkipCachedHandle(cached(800, 91), BAND, NOW), false);
});

test('a custom TTL is honoured', () => {
  assert.equal(shouldSkipCachedHandle(cached(800, 10), BAND, NOW, 7), false);
  assert.equal(shouldSkipCachedHandle(cached(800, 5), BAND, NOW, 7), true);
});

test('a malformed measurement fails open — re-scrape rather than exclude on junk', () => {
  assert.equal(shouldSkipCachedHandle({ ...cached(800), measuredAt: 'not a date' }, BAND, NOW), false);
  assert.equal(shouldSkipCachedHandle({ ...cached(NaN) }, BAND, NOW), false);
  assert.equal(shouldSkipCachedHandle({ ...cached(Infinity) }, BAND, NOW), false);
});

test('a future timestamp is not treated as expired', () => {
  const future: CachedMeasurement = {
    platform: 'instagram', handle: 'h', followerCount: 800,
    measuredAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
  };
  assert.equal(shouldSkipCachedHandle(future, BAND, NOW), true);
});

// ── Latest-measurement reduction ──────────────────────────────────────────────

test('the most recent measurement per handle wins', () => {
  const m = latestMeasurements([
    { platform: 'instagram', handle: 'a', follower_count: 500, measured_at: daysAgo(30) },
    { platform: 'instagram', handle: 'a', follower_count: 900, measured_at: daysAgo(2) },
    { platform: 'instagram', handle: 'a', follower_count: 700, measured_at: daysAgo(10) },
  ]);

  assert.equal(m.size, 1);
  assert.equal(m.get(cacheKey('instagram', 'a'))?.followerCount, 900);
});

test('rows with no measurement are ignored — they are log, not cache', () => {
  const m = latestMeasurements([
    { platform: 'instagram', handle: 'a', follower_count: null, measured_at: null },
    { platform: 'instagram', handle: 'b', follower_count: 500, measured_at: daysAgo(1) },
  ]);

  assert.equal(m.size, 1);
  assert.equal(m.has(cacheKey('instagram', 'a')), false);
});

test('the same handle on two platforms is two entries', () => {
  const m = latestMeasurements([
    { platform: 'instagram', handle: 'a', follower_count: 500, measured_at: daysAgo(1) },
    { platform: 'tiktok', handle: 'a', follower_count: 900, measured_at: daysAgo(1) },
  ]);

  assert.equal(m.size, 2);
  assert.equal(m.get(cacheKey('instagram', 'a'))?.followerCount, 500);
  assert.equal(m.get(cacheKey('tiktok', 'a'))?.followerCount, 900);
});

test('handles are normalised, so casing and a stray @ still match', () => {
  const m = latestMeasurements([
    { platform: 'instagram', handle: '@CreatorOne', follower_count: 500, measured_at: daysAgo(1) },
  ]);

  assert.equal(m.get(cacheKey('instagram', 'creatorone'))?.followerCount, 500);
  assert.equal(m.get(cacheKey('instagram', '@CREATORONE'))?.followerCount, 500);
});

test('an empty input gives an empty map', () => {
  assert.equal(latestMeasurements([]).size, 0);
});
