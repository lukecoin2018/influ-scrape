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
  /** Handles a profile scrape was paid for. */
  profilesScraped: number;
  /** Handles resolved from the search item's author metadata, at no cost. */
  resolvedFree: number;
  creatorsInRange: number;
  newCreatorsAdded: number;
  existingCreatorsUpdated: number;
}

/**
 * Outcomes that mean a handle reached the profile scrape and was billed.
 *
 * The two rejected_* values are deliberately NOT here. A candidate can reach
 * them two ways: measured by a profile scrape (billed), or measured from the
 * search item's own author metadata (free). Counting the outcome alone would
 * report every free rejection as a paid scrape — on the first TikTok probe it
 * reported 43 profiles scraped when 20 were, because 23 had been rejected for
 * nothing. That inflates the one number the whole pre-scrape filter exists to
 * bring down.
 *
 * follower_count_source is what separates them, so profilesScraped reads that
 * rather than the outcome.
 */
const SCRAPED: CandidateOutcome[] = [
  'imported_active',
  'imported_archive_high',
  'imported_archive_low',
  'unknown_size',
  'scrape_missing',
  // Billed: it was scraped and measured. The write is what failed.
  'import_failed',
];

/** Rejected on a measurement, by either route. Billed only if scraped. */
const REJECTED: CandidateOutcome[] = ['rejected_below_floor', 'rejected_above_max'];

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
  resolvedFree: 0,
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
  rows: { outcome: string; follower_count_source?: string | null }[],
): RunTotals {
  const count = (set: CandidateOutcome[]) =>
    rows.filter(r => (set as string[]).includes(r.outcome)).length;

  // A rejection is only a scrape if a scrape produced it. Rows written before
  // follower_count_source existed have it null; those predate the pre-scrape
  // filter entirely, so treating them as scraped is correct for them.
  const rejected = rows.filter(r => (REJECTED as string[]).includes(r.outcome));
  const rejectedByScrape = rejected.filter(r => r.follower_count_source !== 'search_item').length;
  const rejectedFree = rejected.length - rejectedByScrape;

  return {
    uniqueHandlesFound: rows.length,
    profilesScraped: count(SCRAPED) + rejectedByScrape,
    resolvedFree: rejectedFree,
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
