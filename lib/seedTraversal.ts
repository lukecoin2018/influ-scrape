/**
 * Judging a seed traversal against the seed's own following count — pure.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────
 *
 * The discovery route's extraction guard is
 *
 *     posts.length > 0 && candidates.length === 0
 *
 * which is right for a SEARCH: a term nobody posted under legitimately returns
 * nothing, so zero items is a result and not a failure. That guard was ported
 * to seed expansion unchanged, and for a seed it can never fire, because the
 * failure mode is zero items rather than items-without-handles.
 *
 * @ramecabrera follows 383 accounts. The traversal returned 0. The run reported
 * as healthy, logged no candidates, and marked the seed expanded.
 *
 * FOR A SEED, EMPTY IS NEVER LEGITIMATE WHEN following_count IS NON-ZERO — and
 * the application already holds that number. The comparison proves itself; it
 * just was not being made.
 *
 * ── WHY A SHORTFALL IS REPORTED AND NOT ONLY A ZERO ────────────────────────
 *
 * A partial return is the same failure caught earlier. Forty of 383 is not
 * "this seed is small", it is a traversal that stopped, and it should be
 * legible as such rather than passing as a thin result. Zero is an ERROR;
 * a large shortfall is a WARNING, because a following list can legitimately
 * shrink between enrichment and traversal, and because the actor stops at the
 * depth requested.
 */

/** Below this fraction of what was expected, a return is reported as short. */
export const SEED_SHORTFALL_RATIO = 0.5;

export type SeedTraversalVerdict = 'ok' | 'short' | 'unretrievable' | 'unknown';

export interface SeedTraversalJudgement {
  verdict: SeedTraversalVerdict;
  /** Items the actor returned. */
  returned: number;
  /** What the seed claims to follow. Null when we hold no profile for it. */
  followingCount: number | null;
  /**
   * Items a complete traversal should have produced: the depth requested,
   * capped by what the seed actually follows. Null when followingCount is.
   */
  expected: number | null;
  /** True only for 'unretrievable' — the run must be reported as failed. */
  extractionFailed: boolean;
  /** Evidence, stored on the profile and shown in the run response. */
  note: string;
}

export function judgeSeedTraversal(
  returned: number,
  followingCount: number | null,
  requestedDepth: number,
): SeedTraversalJudgement {
  // No profile row, so nothing to compare against. A hand-typed seed handle
  // reaches this. Returning 'unknown' rather than guessing keeps "we did not
  // check" distinct from "we checked and it was fine" — the same NULL-semantics
  // rule the place and language columns follow.
  if (followingCount === null) {
    return {
      verdict: 'unknown',
      returned,
      followingCount: null,
      expected: null,
      extractionFailed: false,
      note: `${returned} following entries returned; no stored profile, so the ` +
            `result could not be checked against a known following count.`,
    };
  }

  const expected = Math.min(followingCount, requestedDepth);

  // A seed that genuinely follows nobody. Vanishingly rare above the queue's
  // 150 threshold, but it is a real zero rather than a failed fetch, and
  // calling it unretrievable would be wrong.
  if (expected === 0) {
    return {
      verdict: 'ok',
      returned,
      followingCount,
      expected: 0,
      extractionFailed: false,
      note: `@ follows nobody, so an empty traversal is correct.`,
    };
  }

  if (returned === 0) {
    return {
      verdict: 'unretrievable',
      returned: 0,
      followingCount,
      expected,
      extractionFailed: true,
      note:
        `0 of ${followingCount} following returned. The account is public and ` +
        `its profile was reachable, so this is TikTok's per-user connections ` +
        `privacy setting hiding the following list — which is NOT the same as ` +
        `privateAccount, and reads normally on the profile.`,
    };
  }

  if (returned < expected * SEED_SHORTFALL_RATIO) {
    return {
      verdict: 'short',
      returned,
      followingCount,
      expected,
      extractionFailed: false,
      note:
        `${returned} of ${expected} expected returned ` +
        `(${Math.round((returned / expected) * 100)}%), against a following ` +
        `count of ${followingCount}. Partial traversal — the list may have ` +
        `shrunk, or the actor stopped early.`,
    };
  }

  return {
    verdict: 'ok',
    returned,
    followingCount,
    expected,
    extractionFailed: false,
    note: `${returned} of ${expected} expected returned, against a following count of ${followingCount}.`,
  };
}
