import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAuthorMeta,
  summariseAuthorMetaCoverage,
  shouldHaltOnCoverage,
  MIN_FOLLOWER_COVERAGE,
} from './tiktokAuthorMeta.ts';

const post = (meta: Record<string, unknown>) => ({ authorMeta: meta, text: 'x' });

// ── The handle rule ───────────────────────────────────────────────────────────

test('authorMeta.nickName is NEVER used as a handle', () => {
  // nickName is the display name. Reading it as a handle is what produced the
  // stored fragments "levi", "lor" and "the".
  const m = extractAuthorMeta([
    post({ name: 'maccosmetics', nickName: 'M·A·C Cosmetics', fans: 90000 }),
  ]);
  assert.deepEqual([...m.keys()], ['maccosmetics']);
  assert.equal(m.has('m·a·c cosmetics'), false);
  assert.equal(m.has('mac cosmetics'), false);
});

test('an item with only a nickName yields nothing at all', () => {
  const m = extractAuthorMeta([post({ nickName: 'Levi Strauss & Co', fans: 500000 })]);
  assert.equal(m.size, 0, 'no handle means no entry, not a guessed one');
});

test('items without authorMeta are skipped, not defaulted', () => {
  const m = extractAuthorMeta([{ text: 'x' }, null, 'string', 42, { authorMeta: null }]);
  assert.equal(m.size, 0);
});

// ── Field presence, never assumed ─────────────────────────────────────────────

test('a missing follower count is null, NOT zero', () => {
  // Zero would be a measurement. Null is the absence of one, and the difference
  // decides whether the band can be applied before scraping.
  const m = extractAuthorMeta([post({ name: 'creatorone' })]);
  assert.equal(m.get('creatorone')?.followerCount, null);
});

test('a genuine zero follower count is kept as zero', () => {
  const m = extractAuthorMeta([post({ name: 'creatorone', fans: 0 })]);
  assert.equal(m.get('creatorone')?.followerCount, 0);
});

test('counts arriving as strings are parsed', () => {
  const m = extractAuthorMeta([post({ name: 'creatorone', fans: '120000' })]);
  assert.equal(m.get('creatorone')?.followerCount, 120000);
});

test('non-boolean flags become null rather than false', () => {
  const m = extractAuthorMeta([post({ name: 'creatorone', ttSeller: 'yes', verified: 1 })]);
  assert.equal(m.get('creatorone')?.ttSeller, null, 'unknown is not "not a seller"');
  assert.equal(m.get('creatorone')?.verified, null);
});

test('all five signals are read when present', () => {
  const m = extractAuthorMeta([post({
    name: 'creatorone', fans: 85000, signature: 'dm for collabs',
    ttSeller: true, verified: false, privateAccount: false,
  })]);
  assert.deepEqual(m.get('creatorone'), {
    handle: 'creatorone', followerCount: 85000, signature: 'dm for collabs',
    ttSeller: true, verified: false, privateAccount: false,
  });
});

test('a handle on several posts merges, so a bare item cannot erase a reading', () => {
  const m = extractAuthorMeta([
    post({ name: 'creatorone', fans: 85000 }),
    post({ name: 'creatorone' }),
    post({ name: 'creatorone', ttSeller: true }),
  ]);
  assert.equal(m.size, 1);
  assert.equal(m.get('creatorone')?.followerCount, 85000);
  assert.equal(m.get('creatorone')?.ttSeller, true);
});

// ── FF1: coverage and the halt ────────────────────────────────────────────────

test('coverage counts each signal independently', () => {
  const c = summariseAuthorMetaCoverage(extractAuthorMeta([
    post({ name: 'aaa', fans: 1, signature: 's', ttSeller: true, verified: true }),
    post({ name: 'bbb', fans: 2 }),
    post({ name: 'ccc' }),
    post({ name: 'ddd' }),
  ]));
  assert.equal(c.items, 4);
  assert.equal(c.withFollowerCount, 2);
  assert.equal(c.withSignature, 1);
  assert.equal(c.withTtSeller, 1);
  assert.equal(c.followerCountRate, 0.5);
});

test('FF1: a run HALTS when the follower count is absent', () => {
  const none = summariseAuthorMetaCoverage(extractAuthorMeta([
    post({ name: 'aaa' }), post({ name: 'bbb' }), post({ name: 'ccc' }),
  ]));
  assert.equal(none.followerCountRate, 0);
  assert.equal(shouldHaltOnCoverage(none), true);
});

test('FF1: a run proceeds when coverage is good', () => {
  const full = summariseAuthorMetaCoverage(extractAuthorMeta([
    post({ name: 'aaa', fans: 1 }), post({ name: 'bbb', fans: 2 }),
  ]));
  assert.equal(full.followerCountRate, 1);
  assert.equal(shouldHaltOnCoverage(full), false);
});

test('FF1: the halt threshold is exactly MIN_FOLLOWER_COVERAGE', () => {
  const at = { items: 10, withFollowerCount: 5, withSignature: 0, withTtSeller: 0,
               withVerified: 0, followerCountRate: MIN_FOLLOWER_COVERAGE };
  const below = { ...at, withFollowerCount: 4, followerCountRate: MIN_FOLLOWER_COVERAGE - 0.01 };
  assert.equal(shouldHaltOnCoverage(at), false, 'at the threshold proceeds');
  assert.equal(shouldHaltOnCoverage(below), true);
});

test('FF1: zero extracted authors is NOT a coverage halt', () => {
  // That is the V3 extraction failure, reported separately. Halting here too
  // would report one problem as another.
  const empty = summariseAuthorMetaCoverage(new Map());
  assert.equal(shouldHaltOnCoverage(empty), false);
});

test('FF1: halting is what stops apidojo economics being adopted by accident', () => {
  // 150 authors with no follower count would each need a $0.005 profile scrape
  // to learn what the search item should have carried for free.
  const c = summariseAuthorMetaCoverage(extractAuthorMeta(
    Array.from({ length: 150 }, (_, i) => post({ name: `creator${i}` })),
  ));
  assert.equal(c.items, 150);
  assert.equal(shouldHaltOnCoverage(c), true);
  assert.equal(Number((c.items * 0.005).toFixed(2)), 0.75, 'the spend the halt avoids');
});

// ── GG1: the halt is configurable ─────────────────────────────────────────────

test('GG1: the halt can be disabled for a deliberate probe', () => {
  const none = summariseAuthorMetaCoverage(extractAuthorMeta([
    post({ name: 'aaa' }), post({ name: 'bbb' }),
  ]));
  assert.equal(shouldHaltOnCoverage(none), true, 'halts by default');
  assert.equal(shouldHaltOnCoverage(none, false), false, 'and not when disabled');
});

test('GG1: disabling the halt does not change what coverage reports', () => {
  const c = summariseAuthorMetaCoverage(extractAuthorMeta([
    post({ name: 'aaa', fans: 1 }), post({ name: 'bbb' }),
  ]));
  assert.equal(c.followerCountRate, 0.5, 'the figure is the same either way');
});

// ── GG2: telling the two causes of partial coverage apart ─────────────────────

test('GG2: authorMeta absent on some posts is distinguishable from fans absent', () => {
  // Case A — the object is missing on some posts.
  const a = summariseAuthorMetaCoverage(
    extractAuthorMeta([post({ name: 'aaa', fans: 1 }), { text: 'no author' }]),
    [post({ name: 'aaa', fans: 1 }), { text: 'no author' }],
  );
  assert.equal(a.rawItems, 2);
  assert.equal(a.rawWithAuthorMeta, 1, 'one post had no authorMeta at all');
  assert.equal(a.rawWithFans, 1);

  // Case B — every post has the object, but not the field.
  const bPosts = [post({ name: 'aaa', fans: 1 }), post({ name: 'bbb' })];
  const b = summariseAuthorMetaCoverage(extractAuthorMeta(bPosts), bPosts);
  assert.equal(b.rawWithAuthorMeta, 2, 'both posts had authorMeta');
  assert.equal(b.rawWithFans, 1, 'only one had fans');

  // Same author-level rate, different cause. That is the point.
  assert.equal(a.followerCountRate, 1);
  assert.equal(b.followerCountRate, 0.5);
  assert.notEqual(a.rawWithAuthorMeta, b.rawWithAuthorMeta);
});

test('GG2: ads are counted separately, with whether they carried a count', () => {
  const posts = [
    { ...post({ name: 'aaa', fans: 100 }), isAd: false },
    { ...post({ name: 'bbb' }), isAd: true },
    { ...post({ name: 'ccc', fans: 200 }), isAd: true },
  ];
  const c = summariseAuthorMetaCoverage(extractAuthorMeta(posts), posts);
  assert.equal(c.rawAds, 2);
  assert.equal(c.rawAdsWithFans, 1, 'so "ads never carry fans" is testable, not assumed');
});

test('GG2: private authors are counted', () => {
  const posts = [
    post({ name: 'aaa', fans: 1, privateAccount: true }),
    post({ name: 'bbb', fans: 2, privateAccount: false }),
  ];
  const c = summariseAuthorMetaCoverage(extractAuthorMeta(posts), posts);
  assert.equal(c.rawPrivateAuthors, 1);
});

test('GG2: item-level counts are zero when no posts are passed', () => {
  const c = summariseAuthorMetaCoverage(extractAuthorMeta([post({ name: 'aaa', fans: 1 })]));
  assert.equal(c.rawItems, 0, 'author-level figures still work without them');
  assert.equal(c.items, 1);
});
