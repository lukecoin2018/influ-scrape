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

/**
 * Per-result prices, by platform, from each actor's own pricing metadata at the
 * FREE subscription tier.
 *
 * Split by platform because the TikTok actors are materially dearer, and a
 * single constant understated a TikTok run by roughly half — which defeats the
 * point of estimating at all.
 *
 *   instagram hashtag  apify/instagram-hashtag-scraper   $0.0026 / result
 *   instagram profile  apify/instagram-profile-scraper   $0.0026 / profile
 *   tiktok    hashtag  clockworks/tiktok-scraper         $0.0037 / result
 *   tiktok    profile  abe/tiktok-profile-scraper        $0.0050 / profile
 *
 * Higher subscription tiers are cheaper, so these read high for anyone on a
 * paid plan. That is deliberate: an estimate that reads low is worse than one
 * that reads high.
 */
export const ACTOR_PRICES_USD = {
  instagram: { hashtagResult: 0.0026, profileResult: 0.0026 },
  tiktok:    { hashtagResult: 0.0037, profileResult: 0.0050 },
} as const;

/** Negative, NaN and non-finite inputs collapse to zero rather than to NaN. */
function count(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export type CostPlatform = keyof typeof ACTOR_PRICES_USD;

/**
 * Results one TikTok search term can return, whatever is asked for.
 *
 * A vendor documents TikTok capping a single query string at roughly 200 unique
 * results, and nobody contradicts it, so it is treated as a platform limit.
 * The shape that follows is many terms shallow, not few terms deep.
 *
 * Without this the estimate multiplies terms by the slider freely and
 * over-states any TikTok term above 200 — quoting for depth the platform will
 * not sell.
 */
export const TIKTOK_SEARCH_RESULT_CAP = 200;

/** Results per term actually obtainable on this platform. */
export function effectiveResultsPerTerm(
  resultsPerHashtag: number,
  platform: CostPlatform,
): number {
  const asked = count(resultsPerHashtag);
  return platform === 'tiktok' ? Math.min(asked, TIKTOK_SEARCH_RESULT_CAP) : asked;
}

/**
 * Unique post authors per post returned.
 *
 * Measured over the 62 rows in discovery_runs: 22,194 unique handles from
 * 29,739 posts. Instagram hashtag pages repeat authors only mildly. The
 * weighted figure is stable across run sizes — runs of 400+ posts give 0.740
 * against 0.746 overall — so a single constant is honest here.
 *
 * Measured on INSTAGRAM runs only; every logged run predates TikTok Discovery.
 * TikTok's ratio is unmeasured and applied here as the best available estimate.
 * The first TikTok run makes it measurable from discovery_candidates.
 */
export const AUTHORS_PER_POST = 0.746;

/**
 * Distinct authors per post on TikTok search.
 *
 * Measured on ONE run — 49 authors from 50 posts on "try on haul" — so this is
 * thin evidence, and it will fall at larger result counts as the same creators
 * recur within a term. Treated as an upper bound rather than a measurement,
 * which makes the estimate read high.
 */
export const TIKTOK_AUTHORS_PER_POST = 0.98;

/**
 * Share of TikTok candidates rejected on the search item's own follower count,
 * before any profile scrape is paid for.
 *
 * Measured on the same single run: 23 of 49 fell outside a 30k-500k band and
 * cost nothing to reject. It varies with the band and the term — a narrow band
 * or a broad term rejects more — so it is an estimate, not a constant of
 * nature.
 *
 * Modelling it matters because without it the estimate assumes every author
 * gets a profile scrape, which over-states a TikTok run by roughly half. It is
 * the number the whole pre-scrape filter exists to move.
 *
 * Already-known handles are ALSO free and are deliberately NOT modelled: that
 * rate depends on what is already in the database, not on the platform. So the
 * estimate reads high on a database that already holds many of the creators a
 * term will surface.
 */
export const TIKTOK_PRESCRAPE_REJECT_RATE = 0.47;

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
  /** Distinct authors those posts are expected to yield. */
  authors: number;
  /** Authors expected to be rejected for free, on the search item's own count. */
  freeRejections: number;
  /** Profile scrapes actually expected to be paid for. */
  authorProfiles: number;
  /** Profile scrapes for detected brands. Zero outside Sponsorship mode. */
  brandProfiles: number;
  hashtagUsd: number;
  profileUsd: number;
  brandUsd: number;
  totalUsd: number;
}

export function estimateDiscoveryCost(
  hashtagCount: number,
  resultsPerHashtag: number,
  mode: DiscoveryMode,
  platform: CostPlatform = 'instagram'
): DiscoveryCostEstimate {
  const price = ACTOR_PRICES_USD[platform] ?? ACTOR_PRICES_USD.instagram;

  const posts = count(hashtagCount) * effectiveResultsPerTerm(resultsPerHashtag, platform);

  const authorsPerPost = platform === 'tiktok' ? TIKTOK_AUTHORS_PER_POST : AUTHORS_PER_POST;
  const authors = Math.round(posts * authorsPerPost);

  // Only TikTok has a pre-scrape filter: clockworks carries authorMeta.fans on
  // the search item. Instagram's hashtag and keyword posts carry nothing about
  // the account, so there every author must be scraped to learn their size.
  const freeRejections = platform === 'tiktok'
    ? Math.round(authors * TIKTOK_PRESCRAPE_REJECT_RATE)
    : 0;
  const authorProfiles = authors - freeRejections;

  // Sponsorship mode is Instagram-only, so brand profiles are always priced at
  // the Instagram rate regardless of the platform argument.
  const brandProfiles = mode === 'sponsorship' && platform === 'instagram'
    ? Math.round(posts * BRAND_PROFILES_PER_POST)
    : 0;

  const hashtagUsd = posts * price.hashtagResult;
  const profileUsd = authorProfiles * price.profileResult;
  const brandUsd = brandProfiles * ACTOR_PRICES_USD.instagram.profileResult;

  return {
    posts,
    authors,
    freeRejections,
    authorProfiles,
    brandProfiles,
    hashtagUsd,
    profileUsd,
    brandUsd,
    totalUsd: hashtagUsd + profileUsd + brandUsd,
  };
}
