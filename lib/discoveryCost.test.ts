import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateDiscoveryCost,
  AUTHORS_PER_POST,
  HASHTAG_RESULT_USD,
  PROFILE_RESULT_USD,
  BRAND_PROFILES_PER_POST,
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
  assert.equal(spon.brandUsd, spon.brandProfiles * PROFILE_RESULT_USD);
});

test('components sum to the total', () => {
  for (const mode of ['niche', 'sponsorship'] as const) {
    const e = estimateDiscoveryCost(7, 130, mode);
    assert.equal(e.totalUsd, e.hashtagUsd + e.profileUsd + e.brandUsd);
    assert.equal(e.hashtagUsd, e.posts * HASHTAG_RESULT_USD);
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
