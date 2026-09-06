import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSeedTraversal, SEED_SHORTFALL_RATIO } from './seedTraversal.ts';

/**
 * The @ramecabrera case, first, because it is the reason this module exists.
 *
 * Apify run sBO40FJkCliMIu1Xu, 2026-09-05: SUCCEEDED, exit 0, 66s, empty
 * dataset, against a stored following_count of 383. The route reported a
 * healthy run with zero candidates and marked the seed expanded.
 */
test('0 returned against a known 383 is an extraction failure', () => {
  const j = judgeSeedTraversal(0, 383, 200);

  assert.equal(j.verdict, 'unretrievable');
  assert.equal(j.extractionFailed, true, 'this MUST fail the run, not pass as an empty result');
  assert.equal(j.expected, 200, 'the depth binds, not the following count');
  assert.match(j.note, /0 of 383/);
  assert.match(j.note, /NOT the same as/, 'the note must say this is not privateAccount');
});

test('the guard the route already had could never have caught it', () => {
  // posts.length > 0 && candidates.length === 0 — the search-side extraction
  // guard. With an empty dataset the first clause is false, so it is skipped.
  // This is the whole defect, pinned.
  const posts: unknown[] = [];
  const candidates: string[] = [];
  const searchGuardFires = posts.length > 0 && candidates.length === 0;

  assert.equal(searchGuardFires, false, 'the ported guard cannot fire on zero items');
  assert.equal(
    judgeSeedTraversal(posts.length, 383, 200).extractionFailed, true,
    'the seed-specific check does fire on exactly the same input',
  );
});

test('a healthy traversal is ok and reports what it got', () => {
  const j = judgeSeedTraversal(200, 383, 200);
  assert.equal(j.verdict, 'ok');
  assert.equal(j.extractionFailed, false);
  assert.match(j.note, /200 of 200/);
});

test('a seed smaller than the depth is not a shortfall', () => {
  // camila_mirasmithb follows 16 and returned 16 at depth 200. That is a
  // complete traversal, and calling it 4% short would be wrong.
  const j = judgeSeedTraversal(16, 16, 200);
  assert.equal(j.verdict, 'ok');
  assert.equal(j.expected, 16);
});

test('40 of 383 is reported as short, not passed as a thin result', () => {
  const j = judgeSeedTraversal(40, 383, 200);
  assert.equal(j.verdict, 'short');
  assert.equal(j.extractionFailed, false, 'a shortfall is a warning, not a failure');
  assert.match(j.note, /40 of 200/);
  assert.match(j.note, /20%/);
});

test('the shortfall boundary is exactly SEED_SHORTFALL_RATIO', () => {
  const expected = 200;
  const atBoundary = Math.ceil(expected * SEED_SHORTFALL_RATIO);

  assert.equal(judgeSeedTraversal(atBoundary, 383, 200).verdict, 'ok');
  assert.equal(judgeSeedTraversal(atBoundary - 1, 383, 200).verdict, 'short');
});

test('an unknown following count yields unknown, never a false pass or fail', () => {
  // A hand-typed seed handle with no stored profile. "We did not check" must
  // stay distinct from "we checked and it was fine" — the same NULL semantics
  // the place and language columns use.
  const j = judgeSeedTraversal(0, null, 200);

  assert.equal(j.verdict, 'unknown');
  assert.equal(j.extractionFailed, false, 'we cannot call it a failure without the comparison');
  assert.equal(j.expected, null);
  assert.match(j.note, /could not be checked/);
});

test('a seed that genuinely follows nobody is ok, not unretrievable', () => {
  const j = judgeSeedTraversal(0, 0, 200);
  assert.equal(j.verdict, 'ok');
  assert.equal(j.extractionFailed, false);
});

test('the note always carries the evidence a retry decision needs', () => {
  // The note is stored on the profile so the decision to retry can be made by
  // reading rather than by paying to re-run.
  for (const [returned, following] of [[0, 383], [40, 383], [200, 383], [16, 16]] as const) {
    const j = judgeSeedTraversal(returned, following, 200);
    assert.ok(j.note.length > 20, `note too thin for ${returned}/${following}`);
    assert.match(j.note, /\d/, 'the note must contain numbers');
  }
});
