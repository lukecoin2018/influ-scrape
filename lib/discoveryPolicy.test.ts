import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProfileImport, type ImportOutcome } from './profileImportCore.ts';
import { discoveryImportPolicy, NEAR_MISS_FLOOR } from './discoveryPolicy.ts';
import { DEFAULT_MIN_FOLLOWERS, DEFAULT_MAX_FOLLOWERS } from './followerRange.ts';
import type { ImportableCreator, ImportResult } from './creatorImport.ts';

const BAND = { min: DEFAULT_MIN_FOLLOWERS, max: DEFAULT_MAX_FOLLOWERS };

const igProfile = (username: string, followersCount: number | null) => ({
  username, fullName: username, biography: '', followersCount,
  followsCount: 0, postsCount: 0, verified: false,
});

function saveSpy() {
  const calls: { creators: ImportableCreator[]; platform: string }[] = [];
  const fn = async (creators: ImportableCreator[], platform: string): Promise<ImportResult> => {
    calls.push({ creators: [...creators], platform });
    return {
      saved: creators.length, failed: 0, total: creators.length,
      savedHandles: creators.map(c => c.handle), errors: [],
    };
  };
  return { calls, fn };
}

/** Runs one profile at a given follower count through a given source's policy. */
async function route(followerCount: number | null, source: 'discovery' | 'brand_feed') {
  const save = saveSpy();
  const out: ImportOutcome = await runProfileImport(['h'], {
    range: BAND,
    platform: 'instagram',
    discoveredViaHashtags: [source],
    scrapeBatch: async () => [igProfile('h', followerCount)],
    saveCreators: save.fn,
    // brand-feed passes no policy at all — that omission is the thing under test.
    ...(source === 'discovery' ? { policy: discoveryImportPolicy } : {}),
  });
  const imported = save.calls.flatMap(c => c.creators);
  return {
    out,
    importedStatus: imported[0]?.importStatus ?? null,
    cached: out.cacheOnly.length === 1 ? out.cacheOnly[0] : null,
  };
}

test('the floor is 15,000', () => {
  assert.equal(NEAR_MISS_FLOOR, 15_000);
});

// ── G3: the full routing table, boundaries included ───────────────────────────

test('G3: above max archives high, from EITHER source', async () => {
  for (const source of ['discovery', 'brand_feed'] as const) {
    const r = await route(500_001, source);
    assert.equal(r.importedStatus, 'out_of_range_high', source);
    assert.equal(r.cached, null, `${source} must not cache a mega-creator`);
  }
});

test('G3: exactly 500,000 is in band, 500,001 is not', async () => {
  assert.equal((await route(500_000, 'discovery')).importedStatus, 'active');
  assert.equal((await route(500_001, 'discovery')).importedStatus, 'out_of_range_high');
});

test('G3: brand_feed below min archives low at any size, including below the floor', async () => {
  for (const followers of [800, 5_000, 14_999, 15_000, 29_999]) {
    const r = await route(followers, 'brand_feed');
    assert.equal(r.importedStatus, 'out_of_range_low', `${followers}`);
    assert.equal(r.cached, null, `brand_feed never caches (${followers})`);
  }
});

test('G3: Discovery 15k-30k archives low', async () => {
  for (const followers of [15_000, 20_000, 29_999]) {
    const r = await route(followers, 'discovery');
    assert.equal(r.importedStatus, 'out_of_range_low', `${followers}`);
    assert.equal(r.cached, null, `${followers} is a near miss, not a reject`);
  }
});

test('G3: Discovery below the floor is cache-only with NO creator record', async () => {
  for (const followers of [1, 800, 5_000, 14_999]) {
    const r = await route(followers, 'discovery');
    assert.equal(r.importedStatus, null, `${followers} must not be imported`);
    assert.equal(r.out.saved, 0, `${followers} writes no creator`);
    assert.equal(r.cached?.followerCount, followers);
  }
});

test('G3: the floor boundary — 14,999 caches, 15,000 archives', async () => {
  const below = await route(NEAR_MISS_FLOOR - 1, 'discovery');
  assert.equal(below.importedStatus, null);
  assert.equal(below.cached?.followerCount, 14_999);

  const at = await route(NEAR_MISS_FLOOR, 'discovery');
  assert.equal(at.importedStatus, 'out_of_range_low');
  assert.equal(at.cached, null);
});

test('G3: the band boundary — 29,999 archives low, 30,000 is active', async () => {
  assert.equal((await route(29_999, 'discovery')).importedStatus, 'out_of_range_low');
  assert.equal((await route(30_000, 'discovery')).importedStatus, 'active');
});

test('G3: 0 and null are unknown_size and ARE imported, from either source', async () => {
  for (const source of ['discovery', 'brand_feed'] as const) {
    for (const followers of [0, null]) {
      const r = await route(followers, source);
      assert.equal(r.importedStatus, 'unknown_size', `${source} ${followers}`);
      assert.equal(r.cached, null, 'unmeasured is not a reject — enrichment re-measures it');
    }
  }
});

test('G3: a cache-only handle is still counted as observed', async () => {
  const r = await route(800, 'discovery');
  assert.equal(r.out.outOfRangeLow, 1, 'counters describe what was measured');
  assert.equal(r.out.saved, 0, 'even though nothing was written');
});

// ── G4: the cache entry carries exactly what the cache write needs ────────────

test('G4: cacheOnly entries carry handle, platform and followerCount — and nothing else', async () => {
  const save = saveSpy();
  const out = await runProfileImport(['a', 'b'], {
    range: BAND,
    platform: 'tiktok',
    discoveredViaHashtags: ['grwm'],
    policy: discoveryImportPolicy,
    saveCreators: save.fn,
    scrapeBatch: async () => [
      { username: 'a', displayName: 'A', followers: { raw: 800 } },
      { username: 'b', displayName: 'B', followers: { raw: 900 } },
    ],
  });

  assert.equal(out.cacheOnly.length, 2);
  for (const entry of out.cacheOnly) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['followerCount', 'handle', 'platform'],
      'run_id and hashtag come from the route, not from here',
    );
    assert.equal(entry.platform, 'tiktok');
  }
  assert.deepEqual(out.cacheOnly.map(e => e.followerCount), [800, 900]);
});

test('G4: cacheOnly accumulates across batches', async () => {
  const save = saveSpy();
  const out = await runProfileImport(
    Array.from({ length: 30 }, (_, i) => `h${i}`),
    {
      range: BAND,
      platform: 'instagram',
      discoveredViaHashtags: ['x'],
      policy: discoveryImportPolicy,
      batchSize: 10,
      saveCreators: save.fn,
      scrapeBatch: async batch => batch.map(h => igProfile(h, 500)),
    },
  );

  assert.equal(out.cacheOnly.length, 30);
  assert.equal(out.saved, 0);
  assert.equal(save.calls.length, 3, 'still one save per batch, each with nothing to save');
});
