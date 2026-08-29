import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  totalsFromCandidates,
  sumPostsFound,
  EMPTY_RUN_TOTALS,
} from './discoveryRunTotals.ts';

const rows = (spec: Record<string, number>) =>
  Object.entries(spec).flatMap(([outcome, n]) =>
    Array.from({ length: n }, () => ({ outcome })));

// The real shape of run 328349c2, which exposed the bug.
const FASHIONBLOGGER = {
  imported_active: 6, rejected_below_floor: 65, imported_archive_low: 4, unknown_size: 3,
};
const STREETSTYLE = {
  cached_reject: 4, rejected_below_floor: 66, unknown_size: 1, imported_active: 5,
};

test('BB1: a multi-item run SUMS its items rather than reporting one of them', () => {
  const one = totalsFromCandidates(rows(FASHIONBLOGGER));
  const two = totalsFromCandidates(rows(STREETSTYLE));
  const both = totalsFromCandidates([...rows(FASHIONBLOGGER), ...rows(STREETSTYLE)]);

  assert.equal(both.creatorsInRange, one.creatorsInRange + two.creatorsInRange);
  assert.equal(both.uniqueHandlesFound, one.uniqueHandlesFound + two.uniqueHandlesFound);
  assert.equal(both.profilesScraped, one.profilesScraped + two.profilesScraped);

  // The numbers the run actually produced, against what it recorded.
  assert.equal(both.creatorsInRange, 11, 'both terms, not the first one');
  assert.notEqual(both.creatorsInRange, one.creatorsInRange);
  assert.equal(one.creatorsInRange, 6, 'what the run record wrongly recorded');
  assert.equal(both.uniqueHandlesFound, 154);
});

test('BB1: adding a term can only increase a total, never replace it', () => {
  let previous = EMPTY_RUN_TOTALS;
  let accumulated: { outcome: string }[] = [];

  for (const term of [FASHIONBLOGGER, STREETSTYLE, FASHIONBLOGGER]) {
    accumulated = [...accumulated, ...rows(term)];
    const now = totalsFromCandidates(accumulated);
    for (const key of Object.keys(EMPTY_RUN_TOTALS) as (keyof typeof EMPTY_RUN_TOTALS)[]) {
      assert.ok(now[key] >= previous[key], `${key} went backwards`);
    }
    previous = now;
  }

  assert.equal(previous.creatorsInRange, 17, 'three terms: 6 + 5 + 6');
});

test('BB1: an empty run gives zeroes, not NaN', () => {
  assert.deepEqual(totalsFromCandidates([]), EMPTY_RUN_TOTALS);
});

// ── Outcome classification ────────────────────────────────────────────────────

test('profilesScraped counts every outcome that reached the scrape and was billed', () => {
  const t = totalsFromCandidates(rows({
    imported_active: 1, imported_archive_high: 1, imported_archive_low: 1,
    rejected_below_floor: 1, unknown_size: 1, scrape_missing: 1,
  }));
  assert.equal(t.profilesScraped, 6);
});

test('the free filters are NOT counted as scraped — that is the point of them', () => {
  const t = totalsFromCandidates(rows({
    entity_excluded: 5, already_known: 7, cached_reject: 3, not_scraped: 2,
  }));
  assert.equal(t.profilesScraped, 0, 'nothing here cost a scrape');
  assert.equal(t.uniqueHandlesFound, 17, 'but they were all found');
  assert.equal(t.existingCreatorsUpdated, 7);
});

test('a cached reject creates no record and is not in range', () => {
  const t = totalsFromCandidates(rows({ rejected_below_floor: 40 }));
  assert.equal(t.newCreatorsAdded, 0, 'cache-only writes no creator');
  assert.equal(t.creatorsInRange, 0);
  assert.equal(t.profilesScraped, 40, 'but it was measured, so it was billed');
});

test('unknown_size creates a record even though it is not in range', () => {
  const t = totalsFromCandidates(rows({ unknown_size: 4 }));
  assert.equal(t.newCreatorsAdded, 4, 'it lands in social_profiles for re-measuring');
  assert.equal(t.creatorsInRange, 0);
});

test('uniqueHandlesFound is the row count, which the unique key makes unique', () => {
  // 82 + 76 handles were extracted across the two terms, but a handle seen
  // under both holds one row: (run_id, platform, handle) is unique. Summing
  // per-term counts on the client would have reported 158.
  const t = totalsFromCandidates([...rows(FASHIONBLOGGER), ...rows(STREETSTYLE)]);
  assert.equal(t.uniqueHandlesFound, 154);
  assert.notEqual(t.uniqueHandlesFound, 158);
});

// ── Post count, the one figure the log cannot supply ──────────────────────────

test('sumPostsFound adds every item', () => {
  assert.equal(sumPostsFound([{ postsFound: 100 }, { postsFound: 100 }]), 200);
});

test('sumPostsFound tolerates missing and malformed values', () => {
  assert.equal(sumPostsFound([{}, { postsFound: undefined }, { postsFound: 5 }]), 5);
  assert.equal(sumPostsFound([]), 0);
  assert.ok(!Number.isNaN(sumPostsFound([{ postsFound: NaN }])));
});
