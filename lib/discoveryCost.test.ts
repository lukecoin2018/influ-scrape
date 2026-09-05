import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateDiscoveryCost,
  AUTHORS_PER_POST,
  ACTOR_PRICES_USD,
  BRAND_PROFILES_PER_POST,
  TIKTOK_KEYWORD_RESULT_USD,
} from './discoveryCost.ts';

const round = (n: number) => Math.round(n * 100) / 100;

test('niche default (6 hashtags x 200) costs $5.45, not the $33.00 the old formula gave', () => {
  const e = estimateDiscoveryCost(6, 200, 'niche');
  assert.equal(e.posts, 1200);
  assert.equal(e.authorProfiles, 895);
  assert.equal(e.brandProfiles, 0);
  assert.equal(round(e.totalUsd), 5.45);

  // What SetupPanel.tsx:78 produced before this change.
  const legacy = 6 * 0.5 + (200 / 20) * 3;
  assert.equal(legacy, 33);
});

test('sponsorship default (44 hashtags x 200) costs $84.34, not the $52.00 the old formula gave', () => {
  const e = estimateDiscoveryCost(44, 200, 'sponsorship');
  assert.equal(e.posts, 8800);
  assert.equal(e.authorProfiles, 6565);
  // 8800 * 1.94. The conversion plan quoted 17,067 / $84.32 using the raw
  // measured 1.9394; the shipped constant is rounded to 1.94, since spurious
  // precision on an explicitly unmeasured upper bound is worse than none.
  assert.equal(e.brandProfiles, 17072);
  assert.equal(round(e.totalUsd), 84.34);

  const legacy = 44 * 0.5 + (200 / 20) * 3;
  assert.equal(legacy, 52);
});

test('the profile term scales with hashtag count — the core bug in the old formula', () => {
  const one = estimateDiscoveryCost(1, 200, 'niche');
  const ten = estimateDiscoveryCost(10, 200, 'niche');

  // Ten times the hashtags is ten times the profile spend, to within the
  // rounding of author counts to whole profiles.
  assert.ok(Math.abs(ten.profileUsd / one.profileUsd - 10) < 0.02);
  assert.equal(ten.posts / one.posts, 10);

  // The defect precisely: adding one hashtag moved the OLD estimate by a flat
  // $0.50 whatever the results slider said, while the real added spend is
  // proportional to results-per-hashtag. Legacy is flat across both settings;
  // the corrected one is 5x larger at 5x the results.
  const legacyDelta = (h: number, r: number) =>
    ((h + 1) * 0.5 + (r / 20) * 3) - (h * 0.5 + (r / 20) * 3);
  assert.equal(legacyDelta(5, 100), 0.5);
  assert.equal(legacyDelta(5, 500), 0.5);

  const realDelta = (h: number, r: number) =>
    estimateDiscoveryCost(h + 1, r, 'niche').totalUsd
      - estimateDiscoveryCost(h, r, 'niche').totalUsd;
  assert.ok(Math.abs(realDelta(5, 500) / realDelta(5, 100) - 5) < 0.02);
});

test('sponsorship adds a brand-profile term that niche does not', () => {
  const niche = estimateDiscoveryCost(10, 100, 'niche');
  const spon = estimateDiscoveryCost(10, 100, 'sponsorship');

  assert.equal(niche.brandProfiles, 0);
  assert.equal(niche.brandUsd, 0);
  assert.ok(spon.brandProfiles > 0);
  assert.equal(spon.posts, niche.posts);
  assert.equal(spon.authorProfiles, niche.authorProfiles);
  assert.equal(spon.brandUsd, spon.brandProfiles * ACTOR_PRICES_USD.instagram.profileResult);
});

test('components sum to the total', () => {
  for (const mode of ['niche', 'sponsorship'] as const) {
    const e = estimateDiscoveryCost(7, 130, mode);
    assert.equal(e.totalUsd, e.hashtagUsd + e.profileUsd + e.brandUsd);
    assert.equal(e.hashtagUsd, e.posts * ACTOR_PRICES_USD.instagram.hashtagResult);
    assert.equal(e.authorProfiles, Math.round(e.posts * AUTHORS_PER_POST));
  }
});

test('degenerate inputs give zero, never NaN', () => {
  for (const [h, r] of [[0, 200], [6, 0], [-3, 200], [6, -1], [NaN, 200], [6, NaN], [Infinity, 200]]) {
    const e = estimateDiscoveryCost(h as number, r as number, 'sponsorship');
    assert.equal(e.posts, 0, `posts for (${h}, ${r})`);
    assert.equal(e.totalUsd, 0, `total for (${h}, ${r})`);
    assert.ok(!Number.isNaN(e.totalUsd));
  }
});

test('fractional slider values floor rather than producing fractional posts', () => {
  const e = estimateDiscoveryCost(2.9, 100.7, 'niche');
  assert.equal(e.posts, 200);
});

test('the first-run configuration from the conversion plan is under a dollar', () => {
  const e = estimateDiscoveryCost(2, 100, 'niche');
  assert.equal(e.posts, 200);
  assert.equal(e.authorProfiles, 149);
  assert.ok(e.totalUsd < 1, `expected under $1, got ${e.totalUsd}`);
  assert.equal(round(e.totalUsd), 0.91);
});

test('BRAND_PROFILES_PER_POST is the documented upper bound', () => {
  assert.equal(BRAND_PROFILES_PER_POST, 1.94);
});

// ── L2: platform-split pricing ────────────────────────────────────────────────

test('L2: TikTok still costs more than Instagram for the same run', () => {
  const ig = estimateDiscoveryCost(6, 200, 'niche', 'instagram');
  const tt = estimateDiscoveryCost(6, 200, 'niche', 'tiktok');

  assert.equal(ig.posts, tt.posts);
  assert.ok(tt.totalUsd > ig.totalUsd, 'dearer actors, even after the filter');
  assert.equal(round(ig.totalUsd), 5.45);
  assert.equal(round(tt.totalUsd), 7.56);
});

// ── LL1: the pre-scrape filter is modelled, not ignored ──────────────────────

test('LL1: TikTok expects fewer profile scrapes than authors — Instagram does not', () => {
  const tt = estimateDiscoveryCost(4, 200, 'niche', 'tiktok');
  assert.equal(tt.authors, 784);
  assert.equal(tt.freeRejections, 368, 'rejected on the search item, at no cost');
  assert.equal(tt.authorProfiles, 416);
  assert.equal(tt.authors, tt.freeRejections + tt.authorProfiles);

  // Instagram carries nothing about the account on a post, so every author
  // must be scraped to learn their size.
  const ig = estimateDiscoveryCost(4, 200, 'niche', 'instagram');
  assert.equal(ig.freeRejections, 0);
  assert.equal(ig.authorProfiles, ig.authors);
});

test('LL1: ignoring the filter over-stated a TikTok run by about half', () => {
  const tt = estimateDiscoveryCost(4, 200, 'niche', 'tiktok');
  // What the estimate said before the filter was modelled: every author scraped.
  const naive = tt.hashtagUsd + tt.authors * ACTOR_PRICES_USD.tiktok.profileResult;
  assert.equal(round(naive), 6.88);
  assert.equal(round(tt.totalUsd), 5.04);
  assert.ok(naive / tt.totalUsd > 1.3, 'the over-statement the filter removes');
});

test('LL1: the probe configuration estimates close to what it actually cost', () => {
  // One term at 50 results billed $0.18 in total.
  const e = estimateDiscoveryCost(1, 50, 'niche', 'tiktok');
  assert.equal(e.posts, 50);
  assert.equal(e.authors, 49, 'the probe found 49 authors in 50 posts');
  assert.equal(e.freeRejections, 23, 'and rejected 23 for free');
  assert.equal(round(e.hashtagUsd), 0.19, 'clockworks billed $0.12 at a lower tier');
  assert.ok(e.totalUsd < 0.40);
});

test('LL1: the estimate reads high, never low', () => {
  // Already-known handles are free too and are deliberately unmodelled, so the
  // figure is an upper bound on a database that already holds the creators.
  const e = estimateDiscoveryCost(1, 200, 'niche', 'tiktok');
  assert.equal(e.freeRejections + e.authorProfiles, e.authors);
  assert.ok(e.authorProfiles > 0);
});

test('L2: the platform defaults to instagram, so existing callers are unchanged', () => {
  assert.deepEqual(
    estimateDiscoveryCost(6, 200, 'niche'),
    estimateDiscoveryCost(6, 200, 'niche', 'instagram'),
  );
});

test('L2: sponsorship adds no brand term on TikTok — that mode is Instagram-only', () => {
  const tt = estimateDiscoveryCost(44, 200, 'sponsorship', 'tiktok');
  assert.equal(tt.brandProfiles, 0);
  assert.equal(tt.brandUsd, 0);

  const ig = estimateDiscoveryCost(44, 200, 'sponsorship', 'instagram');
  assert.ok(ig.brandProfiles > 0);
});

test('L2: prices are the ones read from each actor', () => {
  assert.equal(ACTOR_PRICES_USD.instagram.hashtagResult, 0.0026);
  assert.equal(ACTOR_PRICES_USD.instagram.profileResult, 0.0026);
  assert.equal(ACTOR_PRICES_USD.tiktok.hashtagResult, 0.0037);
  assert.equal(ACTOR_PRICES_USD.tiktok.profileResult, 0.0050);
});

test('L2: the first-run configuration is still under a dollar on Instagram', () => {
  assert.ok(estimateDiscoveryCost(2, 100, 'niche', 'instagram').totalUsd < 1);
});

/**
 * The assertion whose absence let a tested helper go unwired.
 *
 * searchResultPrice was added with the keyword-actor swap and covered by four
 * assertions in discoverySources.test.ts. estimateDiscoveryCost never called
 * it, so the panel quoted every TikTok keyword run at the clockworks rate —
 * about 15x the real search cost — and no test noticed, because every test
 * proved the helper was RIGHT and none proved it was USED.
 *
 * These assert on the estimate, not on the helper. That is the whole point.
 */
test('a TikTok keyword estimate uses the keyword actor price, not the hashtag one', () => {
  const keyword = estimateDiscoveryCost(6, 200, 'niche', 'tiktok', 'keyword');
  const hashtag = estimateDiscoveryCost(6, 200, 'niche', 'tiktok', 'hashtag');

  assert.notEqual(
    keyword.hashtagUsd, hashtag.hashtagUsd,
    'the two TikTok sources are different actors at different prices',
  );
  assert.equal(keyword.hashtagUsd, 1200 * TIKTOK_KEYWORD_RESULT_USD);
  assert.equal(hashtag.hashtagUsd, 1200 * ACTOR_PRICES_USD.tiktok.hashtagResult);
  assert.ok(
    keyword.hashtagUsd < hashtag.hashtagUsd / 10,
    'the keyword actor is an order of magnitude cheaper; a quote that is not is the old bug',
  );
});

test('the profile scrape is priced the same whichever TikTok source found the handle', () => {
  // Only the SEARCH price differs between the two actors. The profile scrape
  // is the same actor either way, so wiring the search price must not have
  // moved this.
  const keyword = estimateDiscoveryCost(6, 200, 'niche', 'tiktok', 'keyword');
  const hashtag = estimateDiscoveryCost(6, 200, 'niche', 'tiktok', 'hashtag');

  assert.equal(keyword.profileUsd, hashtag.profileUsd);
  assert.equal(keyword.authorProfiles, hashtag.authorProfiles);
});

test('Instagram prices both its sources identically — one actor, two flags', () => {
  const keyword = estimateDiscoveryCost(6, 200, 'niche', 'instagram', 'keyword');
  const hashtag = estimateDiscoveryCost(6, 200, 'niche', 'instagram', 'hashtag');

  assert.deepEqual(keyword, hashtag);
});
