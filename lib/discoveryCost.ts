import type { DiscoveryMode } from './types';

/**
 * Cost estimation for a Discovery run.
 *
 * Replaces the two invented constants in components/SetupPanel.tsx, which
 * priced a run as `hashtags * 0.5 + (resultsPerHashtag / 20) * 3`. That
 * expression was wrong in both directions:
 *
 *  - The profile term read the results slider alone and was never multiplied
 *    by the hashtag count, so adding hashtags raised real post volume linearly
 *    while moving the estimate by $0.50 each. On the shipped niche defaults it
 *    overstated a $5.45 run as $33.00.
 *  - Sponsorship mode scrapes a profile for every detected brand
 *    (app/page.tsx:363-407). That spend was not counted at all, so the
 *    44-hashtag sponsorship default understated.
 *
 * Prices are per-result charges read from each actor's own pricing metadata
 * on the Apify API, at the FREE subscription tier. Higher tiers are cheaper
 * (GOLD is roughly 0.0019 / 0.0016), so these estimates are an upper bound for
 * anyone on a paid plan — deliberately, since an estimate that reads low is
 * worse than one that reads high.
 */

/** apify/instagram-hashtag-scraper, `result` event, FREE tier. */
export const HASHTAG_RESULT_USD = 0.0026;

/** apify/instagram-profile-scraper, `profile` event, FREE tier. */
export const PROFILE_RESULT_USD = 0.0026;

/**
 * Unique post authors per post returned.
 *
 * Measured over the 62 rows in discovery_runs: 22,194 unique handles from
 * 29,739 posts. Instagram hashtag pages repeat authors only mildly. The
 * weighted figure is stable across run sizes — runs of 400+ posts give 0.740
 * against 0.746 overall — so a single constant is honest here.
 */
export const AUTHORS_PER_POST = 0.746;

/**
 * Distinct brand profiles scraped per sponsored post, in Sponsorship mode.
 *
 * UNMEASURED AT RUN SCALE — treat as an upper bound. 1.94 is distinct brands
 * per sponsored post across the whole corpus (14,138 distinct brands over
 * 7,290 Instagram sponsored posts). But app/page.tsx accumulates brand handles
 * into a Set spanning the entire run, and the same major brands recur across a
 * 44-hashtag sponsorship sweep, so within-run dedupe will pull the real figure
 * well below this.
 *
 * It could not be derived from run history: discovery_runs.discovery_mode is
 * null for all 62 rows, so sponsorship runs are indistinguishable from niche
 * ones in the log. Populating that column is part of a later change, after
 * which this constant should be re-derived from a real sponsorship run.
 */
export const BRAND_PROFILES_PER_POST = 1.94;

export interface DiscoveryCostEstimate {
  /** Posts the hashtag scraper is asked for: hashtags x results each. */
  posts: number;
  /** Profile scrapes for post authors, after within-run handle dedupe. */
  authorProfiles: number;
  /** Profile scrapes for detected brands. Zero outside Sponsorship mode. */
  brandProfiles: number;
  hashtagUsd: number;
  profileUsd: number;
  brandUsd: number;
  totalUsd: number;
}

/** Negative, NaN and non-finite inputs collapse to zero rather than to NaN. */
function count(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function estimateDiscoveryCost(
  hashtagCount: number,
  resultsPerHashtag: number,
  mode: DiscoveryMode
): DiscoveryCostEstimate {
  const posts = count(hashtagCount) * count(resultsPerHashtag);
  const authorProfiles = Math.round(posts * AUTHORS_PER_POST);
  const brandProfiles = mode === 'sponsorship'
    ? Math.round(posts * BRAND_PROFILES_PER_POST)
    : 0;

  const hashtagUsd = posts * HASHTAG_RESULT_USD;
  const profileUsd = authorProfiles * PROFILE_RESULT_USD;
  const brandUsd = brandProfiles * PROFILE_RESULT_USD;

  return {
    posts,
    authorProfiles,
    brandProfiles,
    hashtagUsd,
    profileUsd,
    brandUsd,
    totalUsd: hashtagUsd + profileUsd + brandUsd,
  };
}
