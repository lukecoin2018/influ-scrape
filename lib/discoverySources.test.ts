import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthorHandles } from './discoveryPosts.ts';
import {
  extractAuthorMeta,
  extractSearchAuthorMetaFromChannel,
  extractPoiByHandle,
  summariseAuthorMetaCoverage,
  shouldHaltOnCoverage,
} from './tiktokAuthorMeta.ts';
import { searchResultPrice, TIKTOK_KEYWORD_RESULT_USD, ACTOR_PRICES_USD } from './discoveryCost.ts';

// Fixtures copied from a real xmolodtsov run for "miami swim", including the
// null entries its hashtags array actually contains.
const xmItem = (over: Record<string, unknown> = {}) => ({
  id: '7485212175208959262',
  inputSource: 'miami swim',
  title: 'walking the runway wearing @Bikini Flavors #fashion #fyp',
  hashtags: ['', null, null, 'fashion', 'fyp'],
  views: 59100,
  channel: {
    id: '6811511969495303174',
    name: 'Jeff Sarita',
    username: 'therunwayexperience',
    verified: false,
    followers: 426600,
    following: 359,
    videos: 335,
    likes: 4800000,
  },
  poi: {
    poiName: 'Miami',
    address: 'Miami, FL, United States',
    cityCode: '4164138',
    cityName: null, latitude: null, longitude: null, regionCode: null,
  },
  ...over,
});

// clockworks shape, for the branch that must not change
const cwItem = (name: string, fans: number | null) => ({
  authorMeta: { name, fans, signature: 'bio here', ttSeller: true, verified: true },
  text: 'caption here',
});

// ── extractAuthorHandles: the (platform, source) branch ─────────────────────

test('keyword source reads channel.username', () => {
  assert.deepEqual(extractAuthorHandles([xmItem()], 'tiktok', 'keyword'),
    ['therunwayexperience']);
});

test('the clockworks branch is unchanged, and is still the default', () => {
  const posts = [cwItem('someone', 1000)];
  assert.deepEqual(extractAuthorHandles(posts, 'tiktok', 'hashtag'), ['someone']);
  assert.deepEqual(extractAuthorHandles(posts, 'tiktok'), ['someone'],
    'omitting source must behave exactly as before this change');
});

test('the readers do not cross: each shape is empty under the other source', () => {
  // The whole point of branching. A shape change must surface as an empty
  // result for that source, not be silently rescued by the other reader.
  assert.deepEqual(extractAuthorHandles([xmItem()], 'tiktok', 'hashtag'), []);
  assert.deepEqual(extractAuthorHandles([cwItem('someone', 1)], 'tiktok', 'keyword'), []);
});

test('Instagram ignores the source argument', () => {
  const ig = [{ ownerUsername: 'iguser' }];
  assert.deepEqual(extractAuthorHandles(ig, 'instagram', 'keyword'), ['iguser']);
  assert.deepEqual(extractAuthorHandles(ig, 'instagram', 'hashtag'), ['iguser']);
});

test('malformed items are skipped rather than throwing', () => {
  const posts = [null, 'nope', {}, { channel: null }, { channel: {} }, xmItem()];
  assert.deepEqual(extractAuthorHandles(posts as unknown[], 'tiktok', 'keyword'),
    ['therunwayexperience']);
});

// ── extractSearchAuthorMetaFromChannel ──────────────────────────────────────

test('the follower count survives the actor switch — the whole point', () => {
  const m = extractSearchAuthorMetaFromChannel([xmItem()]);
  const meta = m.get('therunwayexperience')!;
  assert.equal(meta.followerCount, 426600);
  assert.equal(meta.verified, false);
});

test('signature and ttSeller are null, deliberately and knowingly', () => {
  // Accepted when keyword search moved actors: the bio resolved a location for
  // 18% of candidates and never reached city level.
  const meta = extractSearchAuthorMetaFromChannel([xmItem()]).get('therunwayexperience')!;
  assert.equal(meta.signature, null);
  assert.equal(meta.ttSeller, null);
  assert.equal(meta.privateAccount, null);
});

test('a missing follower count is null, NOT zero', () => {
  // Zero is a legitimate follower count. Conflating them would send a real
  // account into the below-floor reject cache on a reading that never happened.
  const m = extractSearchAuthorMetaFromChannel([xmItem({
    channel: { username: 'nofans', verified: true },
  })]);
  assert.equal(m.get('nofans')!.followerCount, null);
});

test('counts arriving as strings are parsed', () => {
  const m = extractSearchAuthorMetaFromChannel([xmItem({
    channel: { username: 'stringy', followers: '12345' },
  })]);
  assert.equal(m.get('stringy')!.followerCount, 12345);
});

test('a later bare item cannot erase an earlier reading', () => {
  const m = extractSearchAuthorMetaFromChannel([
    xmItem(),
    xmItem({ channel: { username: 'therunwayexperience' } }),
  ]);
  assert.equal(m.get('therunwayexperience')!.followerCount, 426600);
});

test('the coverage summary works unchanged on the new shape', () => {
  const posts = [xmItem(), xmItem({ channel: { username: 'second_creator', followers: 500 } })];
  const cov = summariseAuthorMetaCoverage(extractSearchAuthorMetaFromChannel(posts), posts);
  assert.equal(cov.items, 2);
  assert.equal(cov.withFollowerCount, 2);
  assert.equal(cov.followerCountRate, 1);
});

test('the halt is kept as a guard even though 100% coverage never trips it', () => {
  const posts = [xmItem()];
  const cov = summariseAuthorMetaCoverage(extractSearchAuthorMetaFromChannel(posts), posts);
  assert.equal(shouldHaltOnCoverage(cov, true), false, 'full coverage must not halt');
  // But it must still fire if the actor ever silently stops emitting followers.
  const broken = [xmItem({ channel: { username: 'no_follower_field' } })];
  const brokenCov = summariseAuthorMetaCoverage(
    extractSearchAuthorMetaFromChannel(broken), broken);
  assert.equal(shouldHaltOnCoverage(brokenCov, true), true,
    'a silent shape change is exactly what this guards');
});

// ── extractPoiByHandle ──────────────────────────────────────────────────────

test('poi is read into flat fields', () => {
  const p = extractPoiByHandle([xmItem()]).get('therunwayexperience')!;
  assert.deepEqual(p, {
    name: 'Miami', address: 'Miami, FL, United States', cityCode: '4164138',
  });
});

test('an item with no poi contributes nothing', () => {
  assert.equal(extractPoiByHandle([xmItem({ poi: null })]).size, 0);
  assert.equal(extractPoiByHandle([xmItem({ poi: undefined })]).size, 0);
});

test('an all-null poi object is not recorded as a place', () => {
  // 76% of a measured run carried no usable poi; an object of nulls must not
  // become a row that looks like a location was found.
  const empty = extractPoiByHandle([xmItem({
    poi: { poiName: null, address: null, cityCode: null },
  })]);
  assert.equal(empty.size, 0);
});

test('poi merges across a handle\'s posts, first non-empty winning', () => {
  const m = extractPoiByHandle([
    xmItem({ poi: { poiName: null, address: null, cityCode: '4164138' } }),
    xmItem({ poi: { poiName: 'Miami', address: null, cityCode: null } }),
  ]);
  assert.deepEqual(m.get('therunwayexperience'), {
    name: 'Miami', address: null, cityCode: '4164138',
  });
});

// ── pricing ─────────────────────────────────────────────────────────────────

test('TikTok keyword search is priced on its own actor', () => {
  assert.equal(searchResultPrice('tiktok', 'keyword'), TIKTOK_KEYWORD_RESULT_USD);
  assert.equal(searchResultPrice('tiktok', 'hashtag'), ACTOR_PRICES_USD.tiktok.hashtagResult);
  assert.equal(searchResultPrice('tiktok'), ACTOR_PRICES_USD.tiktok.hashtagResult,
    'omitting source must keep the previous price');
});

test('only the one combination differs', () => {
  for (const source of ['hashtag', 'keyword'] as const) {
    assert.equal(searchResultPrice('instagram', source),
      ACTOR_PRICES_USD.instagram.hashtagResult);
  }
});

test('the keyword actor is an order of magnitude cheaper, as measured', () => {
  // clockworks measured $0.00233/result, xmolodtsov $0.000220, on the same
  // term the same day. The constant is rounded up; the ratio must survive it.
  const ratio = ACTOR_PRICES_USD.tiktok.hashtagResult / TIKTOK_KEYWORD_RESULT_USD;
  assert.ok(ratio > 10, `expected >10x cheaper, got ${ratio.toFixed(1)}x`);
});
