import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnumParam,
  parseBoundedInt,
  parseBoolParam,
  firstError,
} from './requestParams.ts';

const SOURCES = ['hashtag', 'keyword'] as const;

// ── LL3: the silent-rewrite class ─────────────────────────────────────────────

test('LL3: what was asked for is what comes back', () => {
  const r = parseEnumParam('searchSource', 'keyword', SOURCES, 'hashtag');
  assert.deepEqual(r, { ok: true, value: 'keyword' });
});

test('LL3: an UNSUPPORTED value errors — it never becomes the fallback', () => {
  // This is the exact failure: a run was started with searchSource 'keyword'
  // and recorded as 'hashtag', because the guard returned the fallback for
  // anything it did not match. A caller must not learn about a substitution
  // from a database column three days later.
  const r = parseEnumParam('searchSource', 'keywords', SOURCES, 'hashtag');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /keywords/);
  assert.match((r as { error: string }).error, /hashtag, keyword/);
});

test('LL3: absent means the default, which is the only silent case allowed', () => {
  for (const absent of [undefined, null, '']) {
    const r = parseEnumParam('searchSource', absent, SOURCES, 'hashtag');
    assert.deepEqual(r, { ok: true, value: 'hashtag' });
  }
});

test('LL3: a wrong TYPE errors rather than coercing', () => {
  for (const bad of [1, true, {}, []]) {
    const r = parseEnumParam('platform', bad, ['instagram', 'tiktok'] as const, 'instagram');
    assert.equal(r.ok, false, `for ${JSON.stringify(bad)}`);
  }
});

test('LL3: the fallback is only reachable by absence, never by invalidity', () => {
  const asked = parseEnumParam('mode', 'sponsorship', ['niche', 'sponsorship'] as const, 'niche');
  const junk = parseEnumParam('mode', 'sponsorships', ['niche', 'sponsorship'] as const, 'niche');
  assert.deepEqual(asked, { ok: true, value: 'sponsorship' });
  assert.equal(junk.ok, false, 'a near-miss typo must not silently run as niche');
});

// ── Bounded integers: clamping is allowed, but reported ───────────────────────

test('a value inside the bounds passes through unclamped', () => {
  assert.deepEqual(parseBoundedInt('n', 200, { min: 1, max: 500, fallback: 100 }),
    { ok: true, value: 200 });
});

test('clamping is REPORTED, so the caller can say what it did', () => {
  const r = parseBoundedInt('resultsPerHashtag', 900, { min: 1, max: 500, fallback: 100 });
  assert.deepEqual(r, { ok: true, value: 500, clamped: true, requested: 900 });
});

test('a non-numeric value errors rather than falling back', () => {
  // `Number('abc') || 100` yielding 100 is the same silent substitution.
  const r = parseBoundedInt('resultsPerHashtag', 'abc', { min: 1, max: 500, fallback: 100 });
  assert.equal(r.ok, false);
});

test('absent gives the fallback, and zero is honoured rather than treated as absent', () => {
  assert.deepEqual(parseBoundedInt('n', undefined, { min: 0, max: 10, fallback: 5 }),
    { ok: true, value: 5 });
  assert.deepEqual(parseBoundedInt('n', 0, { min: 0, max: 10, fallback: 5 }),
    { ok: true, value: 0 });
});

// ── Booleans ──────────────────────────────────────────────────────────────────

test('a boolean is honoured in both directions', () => {
  assert.deepEqual(parseBoolParam('halt', false, true), { ok: true, value: false });
  assert.deepEqual(parseBoolParam('halt', true, false), { ok: true, value: true });
});

test('a stringy boolean errors rather than being guessed', () => {
  // "false" is truthy. Guessing here is how a halt gets silently disabled.
  assert.equal(parseBoolParam('halt', 'false', true).ok, false);
  assert.equal(parseBoolParam('halt', 0, true).ok, false);
});

test('firstError returns the first failure, or null when all pass', () => {
  const good = parseEnumParam('a', 'hashtag', SOURCES, 'hashtag');
  const bad = parseEnumParam('b', 'nope', SOURCES, 'hashtag');
  assert.equal(firstError(good), null);
  assert.match(String(firstError(good, bad)), /nope/);
  assert.match(String(firstError(bad, good)), /nope/);
});
