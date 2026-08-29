import type { CandidateOutcome } from './discoveryCache';

/**
 * Run-level totals.
 *
 * Derived from discovery_candidates rather than accumulated on the client,
 * because the client accumulation was wrong and the log is the record the run
 * actually produced.
 *
 * The bug it replaces: the page read its per-item results out of a ref synced
 * from React state by an effect, then called the finish route in the same async
 * continuation in which the runner's loop resolved — before React had
 * re-rendered. The ref therefore held a prefix of the results, and a two-term
 * run wrote one term's numbers as if they were the whole run. Measured on run
 * 328349c2: discovery_candidates holds 154 rows across two terms with 11
 * imported_active, while the run record read 82 handles and 6 in range —
 * exactly the first term.
 *
 * Deriving server-side removes the class of bug rather than the instance. The
 * counters can no longer disagree with the log they are supposed to summarise,
 * whatever the client does with its state.
 */

export interface RunTotals {
  uniqueHandlesFound: number;
  profilesScraped: number;
  creatorsInRange: number;
  newCreatorsAdded: number;
  existingCreatorsUpdated: number;
}

/** Outcomes that mean a handle reached the profile scrape and was billed. */
const SCRAPED: CandidateOutcome[] = [
  'imported_active',
  'imported_archive_high',
  'imported_archive_low',
  'rejected_below_floor',
  'unknown_size',
  'scrape_missing',
];

/** Outcomes that created a creator record. */
const CREATED_RECORD: CandidateOutcome[] = [
  'imported_active',
  'imported_archive_high',
  'imported_archive_low',
  'unknown_size',
];

export const EMPTY_RUN_TOTALS: RunTotals = {
  uniqueHandlesFound: 0,
  profilesScraped: 0,
  creatorsInRange: 0,
  newCreatorsAdded: 0,
  existingCreatorsUpdated: 0,
};

/**
 * Totals for one run, from its candidate rows.
 *
 * uniqueHandlesFound is the row count, which is unique by construction: the
 * table's unique key is (run_id, platform, handle), so a handle surfacing under
 * two terms in the same run holds one row. Summing per-term candidate counts on
 * the client would double-count it — on run 328349c2, 82 + 76 extracted against
 * 154 rows stored.
 */
export function totalsFromCandidates(
  rows: { outcome: string }[],
): RunTotals {
  const count = (set: CandidateOutcome[]) =>
    rows.filter(r => (set as string[]).includes(r.outcome)).length;

  return {
    uniqueHandlesFound: rows.length,
    profilesScraped: count(SCRAPED),
    creatorsInRange: count(['imported_active']),
    newCreatorsAdded: count(CREATED_RECORD),
    existingCreatorsUpdated: count(['already_known']),
  };
}

/**
 * Posts found across a run's items.
 *
 * The one figure the candidate log cannot supply — posts are the scrape's
 * input, not its output, and a post that yields no candidate leaves no row. So
 * it is still summed from the per-item results, and the caller must accumulate
 * those synchronously rather than reading them back out of React state.
 */
export function sumPostsFound(items: { postsFound?: number }[]): number {
  return items.reduce((total, item) => total + (Number(item.postsFound) || 0), 0);
}
