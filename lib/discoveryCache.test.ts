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

test('the taxonomy matches the CHECK constraint — eleven values, no duplicates', () => {
  // Ten originally; 'rejected_above_max' was added when Discovery stopped
  // archiving out-of-range candidates in either direction. The two
  // imported_archive_* values remain for rows written before that change.
  assert.equal(CANDIDATE_OUTCOMES.length, 11);
  assert.equal(new Set(CANDIDATE_OUTCOMES).size, 11, 'no duplicates');
  assert.ok(CANDIDATE_OUTCOMES.includes('rejected_above_max'));
  assert.ok(CANDIDATE_OUTCOMES.includes('rejected_below_floor'));
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

test('BB2: an above-max measurement IS skipped — Discovery caches those now', () => {
  assert.equal(shouldSkipCachedHandle(cached(900_000), BAND, NOW), true);
  assert.equal(shouldSkipCachedHandle(cached(500_001), BAND, NOW), true);
  assert.equal(shouldSkipCachedHandle(cached(500_000), BAND, NOW), false, 'in band');
});

test('BB2: raising the ceiling re-admits an above-max handle immediately', () => {
  const entry = cached(700_000, 1);
  assert.equal(shouldSkipCachedHandle(entry, { min: 30_000, max: 500_000 }, NOW), true);
  assert.equal(shouldSkipCachedHandle(entry, { min: 30_000, max: 1_000_000 }, NOW), false);
});

test('BB2: re-admission is symmetric — inside the band either way means re-scrape', () => {
  for (const followers of [30_000, 100_000, 500_000]) {
    assert.equal(shouldSkipCachedHandle(cached(followers), BAND, NOW), false, `${followers}`);
  }
  for (const followers of [1, 29_999, 500_001, 9_000_000]) {
    assert.equal(shouldSkipCachedHandle(cached(followers), BAND, NOW), true, `${followers}`);
  }
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
