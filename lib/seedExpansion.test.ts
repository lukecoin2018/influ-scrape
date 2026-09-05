import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthorHandles } from './discoveryPosts.ts';
import { extractAuthorMeta, summariseAuthorMetaCoverage } from './tiktokAuthorMeta.ts';
import { estimateDiscoveryCost, SEED_RESULT_USD, SEED_RUN_START_USD } from './discoveryCost.ts';

/**
 * Seed expansion reuses the entire Discovery funnel unchanged. That is only
 * safe if clockworks/tiktok-followers-scraper really does carry the same
 * `authorMeta` shape the search actors carry, and if the candidate really is
 * `authorMeta` rather than `connectedTo`.
 *
 * Both are load-bearing and neither is guaranteed by a type. If the actor ever
 * swaps the two ends of the edge, every run would import the seed itself over
 * and over and the funnel would report it as a healthy result. These pin it.
 *
 * The fixture is a real item, trimmed, from run LWOz58cSAqNgkKCcO on
 * 2026-09-04 — seed @colgo, dataset HIpIKKxKHBfb6FlVW.
 */
const followingItem = (candidate: string, fans: number, seed = 'colgo') => ({
  authorMeta: {
    id: '7470743469502252033',
    name: candidate,
    nickName: 'display name that is not a handle',
    verified: false,
    signature: 'ig: santiago.tyt',
    bioLink: null,
    privateAccount: false,
    ttSeller: false,
    following: 32,
    fans,
    heart: 96,
    video: 6,
  },
  connectedTo: {
    id: '6829128203124147206',
    name: seed,
    nickName: 'Cólgo Academia',
    verified: false,
    signature: 'Comunicate con nosotros aqui',
    ttSeller: false,
    following: 207,
    fans: 42900,
  },
  connectionType: 'following',
  connectionDescription: `${seed} is following ${candidate}`,
});

test('the candidate is authorMeta, NOT connectedTo', () => {
  const items = [followingItem('wzysg4', 13), followingItem('alirioguaco', 48_000)];
  const handles = extractAuthorHandles(items, 'tiktok', 'seed');

  assert.deepEqual(handles, ['wzysg4', 'alirioguaco']);
  assert.ok(!handles.includes('colgo'), 'the seed must never appear as its own candidate');
});

test('the free follower reading survives the seed path', () => {
  // The whole economic case: rejecting out-of-band costs nothing here, exactly
  // as it does on a search item.
  const metas = extractAuthorMeta([followingItem('wzysg4', 13), followingItem('alirioguaco', 48_000)]);

  assert.equal(metas.get('wzysg4')?.followerCount, 13);
  assert.equal(metas.get('alirioguaco')?.followerCount, 48_000);
  assert.equal(metas.get('wzysg4')?.signature, 'ig: santiago.tyt');
  assert.equal(metas.get('wzysg4')?.ttSeller, false);
});

test('nickName is never mistaken for a handle', () => {
  const metas = extractAuthorMeta([followingItem('wzysg4', 13)]);
  assert.ok(metas.has('wzysg4'));
  assert.equal(metas.size, 1);
});

test('coverage on a following list is complete, so the halt does not fire', () => {
  const items = [followingItem('wzysg4', 13), followingItem('alirioguaco', 48_000)];
  const coverage = summariseAuthorMetaCoverage(extractAuthorMeta(items), items);

  assert.equal(coverage.items, 2);
  assert.equal(coverage.withFollowerCount, 2);
  assert.equal(coverage.followerCountRate, 1);
});

test('a swapped edge is caught as an extraction failure, not a result', () => {
  // What it would look like if the actor moved the candidate into connectedTo:
  // items returned, no authorMeta, and therefore no handles. The route's
  // `posts > 0 && candidates === 0` condition reports this rather than calling
  // it an empty following list.
  const swapped = [{ connectedTo: { name: 'wzysg4' }, connectionType: 'following' }];
  const handles = extractAuthorHandles(swapped, 'tiktok', 'seed');

  assert.deepEqual(handles, []);
  assert.equal(swapped.length > 0 && handles.length === 0, true);
});

// ── Cost ────────────────────────────────────────────────────────────────────

test('seed cost is the following actor, not the search actor', () => {
  const seed = estimateDiscoveryCost(4, 200, 'niche', 'tiktok', 'seed');
  const keyword = estimateDiscoveryCost(4, 200, 'niche', 'tiktok', 'keyword');

  assert.equal(seed.posts, 800);
  // 800 entries at $0.001 plus four run starts at $0.001.
  assert.equal(seed.hashtagUsd, 800 * SEED_RESULT_USD + 4 * SEED_RUN_START_USD);
  assert.ok(seed.hashtagUsd < keyword.hashtagUsd, 'the following list is the cheaper fetch');
});

test('seed cost is unaffected by the TikTok SEARCH cap', () => {
  // 300 > TIKTOK_SEARCH_RESULT_CAP. A following list is not a search, so the
  // cap must not clamp it — clamping here would understate the bill.
  const seed = estimateDiscoveryCost(1, 300, 'niche', 'tiktok', 'seed');
  const keyword = estimateDiscoveryCost(1, 300, 'niche', 'tiktok', 'keyword');

  assert.equal(seed.posts, 300);
  assert.equal(keyword.posts, 200, 'search IS capped');
});

test('seed never prices brand profiles, whatever mode is passed', () => {
  // Sponsorship has no seed path, so a caller that somehow combined them must
  // not be quoted for brand scraping that will never happen.
  const e = estimateDiscoveryCost(3, 100, 'sponsorship', 'tiktok', 'seed');
  assert.equal(e.brandProfiles, 0);
  assert.equal(e.brandUsd, 0);
});

test('the default search source leaves every existing estimate unchanged', () => {
  const implicit = estimateDiscoveryCost(6, 200, 'niche', 'tiktok');
  const explicit = estimateDiscoveryCost(6, 200, 'niche', 'tiktok', 'hashtag');
  assert.deepEqual(implicit, explicit);
});

test('seed estimate reads high: the profile scrape is priced in full', () => {
  // Documented rather than assumed. The following item already carries fans,
  // signature, verified and ttSeller, so importing straight off it would remove
  // the profile term. Nobody has chosen that, so it is still charged — and this
  // pins the number so a silent change to it is visible.
  const e = estimateDiscoveryCost(1, 200, 'niche', 'tiktok', 'seed');
  assert.equal(e.authors, 200);
  assert.equal(e.freeRejections, 127);   // 200 * 0.635
  assert.equal(e.authorProfiles, 73);
  assert.ok(e.profileUsd > e.hashtagUsd, 'the profile scrape dominates the bill');
});

test("'seed' reads the same field as 'hashtag', and NOT the keyword field", () => {
  // The three TikTok sources put the handle in three places. Seed shares
  // clockworks' shape; routing it to the xmolodtsov reader would return
  // nothing and the route would call it an extraction failure.
  const items = [followingItem('wzysg4', 13)];

  assert.deepEqual(extractAuthorHandles(items, 'tiktok', 'seed'), ['wzysg4']);
  assert.deepEqual(extractAuthorHandles(items, 'tiktok', 'hashtag'), ['wzysg4']);
  assert.deepEqual(
    extractAuthorHandles(items, 'tiktok', 'keyword'), [],
    'the keyword reader looks at channel.username, which a following item has not got',
  );
});
