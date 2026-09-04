import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPostLanguage, deriveLanguageFromPosts,
  UNDETERMINED, MIN_LANGUAGE_POSTS, MIN_LANGUAGE_DOMINANCE,
} from './postLanguage.ts';

const post = (textLanguage?: unknown) =>
  textLanguage === undefined ? {} : { textLanguage };
const langs = (...spec: [string, number][]) =>
  spec.flatMap(([l, n]) => Array(n).fill(l === UNDETERMINED ? null : l));

// ── extractPostLanguage ─────────────────────────────────────────────────────

test('a language code is read and lowercased', () => {
  assert.equal(extractPostLanguage(post('en')), 'en');
  assert.equal(extractPostLanguage(post('DE')), 'de');
  assert.equal(extractPostLanguage(post(' sv ')), 'sv');
});

test("'un' is not a language", () => {
  // 15.6% of measured posts. Counting it produces creators whose language is
  // "undetermined", which is worse than no answer.
  assert.equal(extractPostLanguage(post('un')), null);
  assert.equal(extractPostLanguage(post('UN')), null);
});

test('absent or malformed yields null rather than throwing', () => {
  for (const v of [undefined, null, '', 123, {}, []]) {
    assert.equal(extractPostLanguage(post(v)), null);
  }
  assert.equal(extractPostLanguage(null), null);
  assert.equal(extractPostLanguage('nope'), null);
});

// ── deriveLanguageFromPosts ─────────────────────────────────────────────────

test('a clearly monolingual creator resolves with full confidence', () => {
  // @katnimpa: en:13 un:2
  const r = deriveLanguageFromPosts(langs(['en', 13], [UNDETERMINED, 2]));
  assert.equal(r?.language, 'en');
  assert.equal(r?.confidence, 1);
  assert.equal(r?.languagePosts, 13);
  assert.equal(r?.totalPosts, 15);
});

test("a creator who is mostly 'un' does NOT resolve to 'un'", () => {
  // @antonia.andresen: un:13 de:2. The whole reason 'un' is excluded first.
  const r = deriveLanguageFromPosts(langs([UNDETERMINED, 13], ['de', 2]));
  assert.equal(r, null, 'two real posts is below the floor');
  const relaxed = deriveLanguageFromPosts(langs([UNDETERMINED, 13], ['de', 2]), { minPosts: 2 });
  assert.equal(relaxed?.language, 'de', 'and when it does resolve it is de, never un');
});

test('the disagreements the heuristic got wrong now resolve correctly', () => {
  // @kleo_tsvk: en:12 de:3 — heuristic said de.
  assert.equal(deriveLanguageFromPosts(langs(['en', 12], ['de', 3]))?.language, 'en');
  // @hannapannavattenkanna1: sv dominant — heuristic said pt.
  assert.equal(deriveLanguageFromPosts(langs(['sv', 13], [UNDETERMINED, 2]))?.language, 'sv');
  // @bibii.230: ro:6 es:1 it:1 hi:1 — heuristic said fr, which never appears.
  const messy = deriveLanguageFromPosts(langs(['ro', 6], ['es', 1], ['it', 1], ['hi', 1]));
  assert.equal(messy?.language, 'ro');
  assert.ok(messy!.confidence >= 0.6);
  assert.deepEqual(messy!.all.slice(0, 1), ['ro']);
});

test('fewer than three determinable posts yields nothing', () => {
  assert.equal(MIN_LANGUAGE_POSTS, 3);
  assert.equal(deriveLanguageFromPosts(langs(['en', 2], [UNDETERMINED, 13])), null);
  assert.equal(deriveLanguageFromPosts(langs(['en', 3]))?.language, 'en');
});

test('a genuinely mixed creator is left unresolved rather than guessed', () => {
  assert.equal(MIN_LANGUAGE_DOMINANCE, 0.6);
  // @o4mqrie: de:5 en:5 un:5 — a real creator, no dominant language.
  assert.equal(deriveLanguageFromPosts(langs(['de', 5], ['en', 5], [UNDETERMINED, 5])), null);
});

test('exactly at the 60% boundary passes', () => {
  const r = deriveLanguageFromPosts(langs(['en', 3], ['de', 2]));
  assert.equal(r?.language, 'en');
  assert.ok(Math.abs(r!.confidence - 0.6) < 1e-9);
});

test('`all` exposes bilingualism the single answer hides', () => {
  const r = deriveLanguageFromPosts(langs(['es', 8], ['en', 4]));
  assert.equal(r?.language, 'es');
  assert.deepEqual(r?.all, ['es', 'en']);
});

test('a tie is broken deterministically, not by post order', () => {
  const one = deriveLanguageFromPosts(langs(['en', 3], ['de', 3]), { minDominance: 0.5 });
  const two = deriveLanguageFromPosts(langs(['de', 3], ['en', 3]), { minDominance: 0.5 });
  assert.equal(one?.language, two?.language);
  assert.equal(one?.language, 'de', 'lowest code wins a tie');
});

test('an empty or all-undetermined creator yields nothing', () => {
  assert.equal(deriveLanguageFromPosts([]), null);
  assert.equal(deriveLanguageFromPosts(langs([UNDETERMINED, 15])), null);
});
