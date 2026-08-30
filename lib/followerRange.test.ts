import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_FOLLOWERS,
  DEFAULT_MAX_FOLLOWERS,
  hasMeasuredFollowerCount,
  isInFollowerRange,
  importStatusFor,
  isOutOfRange,
  rollUpStatuses,
  normaliseRange,
  type ImportStatus,
} from './followerRange.ts';

const BAND = { min: DEFAULT_MIN_FOLLOWERS, max: DEFAULT_MAX_FOLLOWERS };

test('the band constants are 30k-500k, matching the import_status boundaries in the data', () => {
  assert.equal(DEFAULT_MIN_FOLLOWERS, 30_000);
  assert.equal(DEFAULT_MAX_FOLLOWERS, 500_000);
});

// ── The C2 defect ─────────────────────────────────────────────────────────────

test('0 followers is unmeasured, not active — this is the bug C2 fixes', () => {
  assert.equal(importStatusFor(0, BAND), 'unknown_size');
});

test('null and undefined followers are unmeasured, not active', () => {
  assert.equal(importStatusFor(null, BAND), 'unknown_size');
  assert.equal(importStatusFor(undefined, BAND), 'unknown_size');
});

test('unmeasured is NOT reported as below-range — a failed scrape is not a small account', () => {
  for (const v of [0, null, undefined, NaN, -5]) {
    const status = importStatusFor(v as number, BAND);
    assert.equal(status, 'unknown_size', `for ${String(v)}`);
    assert.notEqual(status, 'out_of_range_low');
  }
});

test('hasMeasuredFollowerCount rejects everything that is not a positive finite number', () => {
  for (const v of [0, -1, null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(hasMeasuredFollowerCount(v as number), false, `for ${String(v)}`);
  }
  for (const v of [1, 29_999, 30_000, 500_000, 500_001, 1e9]) {
    assert.equal(hasMeasuredFollowerCount(v), true, `for ${v}`);
  }
});

test('isInFollowerRange says false for unmeasured — not known to be anywhere', () => {
  assert.equal(isInFollowerRange(0, BAND), false);
  assert.equal(isInFollowerRange(null, BAND), false);
  assert.equal(isInFollowerRange(undefined, BAND), false);
});

// ── Measured verdicts, unchanged by C2 ────────────────────────────────────────

test('measured counts classify by the band, inclusive at both bounds', () => {
  assert.equal(importStatusFor(29_999, BAND), 'out_of_range_low');
  assert.equal(importStatusFor(30_000, BAND), 'active');
  assert.equal(importStatusFor(250_000, BAND), 'active');
  assert.equal(importStatusFor(500_000, BAND), 'active');
  assert.equal(importStatusFor(500_001, BAND), 'out_of_range_high');
});

test('the 30k-50k gap the old Discovery default discarded is in band', () => {
  for (const v of [30_000, 35_000, 49_999]) {
    assert.equal(importStatusFor(v, BAND), 'active', `for ${v}`);
  }
});

test('isOutOfRange treats unknown_size as non-active, so every active gate excludes it', () => {
  assert.equal(isOutOfRange('active'), false);
  assert.equal(isOutOfRange('out_of_range_high'), true);
  assert.equal(isOutOfRange('out_of_range_low'), true);
  assert.equal(isOutOfRange('unknown_size'), true);
});

// ── Roll-up ───────────────────────────────────────────────────────────────────

test('any active profile makes the creator active', () => {
  assert.equal(rollUpStatuses(['out_of_range_low', 'active']), 'active');
  assert.equal(rollUpStatuses(['unknown_size', 'active']), 'active');
  assert.equal(rollUpStatuses(['out_of_range_high', 'unknown_size', 'active']), 'active');
});

test('high still wins over low when directions disagree', () => {
  assert.equal(rollUpStatuses(['out_of_range_low', 'out_of_range_high']), 'out_of_range_high');
});

test('a measured verdict beats an unmeasured one', () => {
  assert.equal(rollUpStatuses(['unknown_size', 'out_of_range_low']), 'out_of_range_low');
  assert.equal(rollUpStatuses(['unknown_size', 'out_of_range_high']), 'out_of_range_high');
});

test('only an entirely unmeasured creator rolls up to unknown_size', () => {
  assert.equal(rollUpStatuses(['unknown_size']), 'unknown_size');
  assert.equal(rollUpStatuses(['unknown_size', 'unknown_size']), 'unknown_size');
});

test('no profiles rolls up to active, as before', () => {
  assert.equal(rollUpStatuses([]), 'active');
});

test('roll-up is order independent', () => {
  const perms: ImportStatus[][] = [
    ['unknown_size', 'out_of_range_high', 'out_of_range_low'],
    ['out_of_range_low', 'unknown_size', 'out_of_range_high'],
    ['out_of_range_high', 'out_of_range_low', 'unknown_size'],
  ];
  for (const p of perms) assert.equal(rollUpStatuses(p), 'out_of_range_high');
});

// ── normaliseRange, untouched by C2 but load-bearing for re-admission ─────────

test('an explicit 0 minimum means no floor, not the default', () => {
  assert.deepEqual(normaliseRange(0, 500_000), { min: 0, max: 500_000 });
});

test('missing bounds fall back to the defaults', () => {
  assert.deepEqual(normaliseRange(null, undefined), { min: 30_000, max: 500_000 });
  assert.deepEqual(normaliseRange('', ''), { min: 30_000, max: 500_000 });
});

test('an inverted range is swapped rather than excluding everyone', () => {
  assert.deepEqual(normaliseRange(500_000, 30_000), { min: 30_000, max: 500_000 });
});

test('lowering the band re-admits a previously below-range count', () => {
  // The soft-reject semantics the C5 reject cache depends on: the verdict is a
  // function of the CURRENT band, so a 18k handle rejected at min 30k
  // classifies as active the moment the band is lowered to 15k.
  assert.equal(importStatusFor(18_000, normaliseRange(30_000, 500_000)), 'out_of_range_low');
  assert.equal(importStatusFor(18_000, normaliseRange(15_000, 500_000)), 'active');
});
