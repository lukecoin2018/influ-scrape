import type { ApifyRunResponse, ApifyRunStatusResponse, HashtagPost, InstagramProfile, DiscoveredCreator } from './types';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

if (!APIFY_TOKEN) {
  console.warn('WARNING: APIFY_API_TOKEN is not set');
}

export async function startHashtagScraper(
  hashtags: string[],
  resultsLimit: number = 100,
  keywordSearch: boolean = false
): Promise<{ runId: string; datasetId?: string }> {
  const actorId = 'apify~instagram-hashtag-scraper';

  // The actor declares exactly four inputs: hashtags, keywordSearch,
  // resultsType, resultsLimit. `searchType` was being sent and is not among
  // them — presumably ignored since the initial commit. Dropped rather than
  // left beside a flag whose effect we are trying to observe.
  const input = {
    hashtags,
    resultsLimit,
    resultsType: 'posts',
    // Same field, different meaning: with this set the entries are treated as
    // free-text keywords rather than tags. The actor's own documentation warns
    // the resulting dataset is "slightly different" from the hashtag one, which
    // is why the route checks that author handles actually came back.
    keywordSearch,
  };

  
  const url = `${APIFY_API_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`;
console.log('🔍 Calling Apify URL:', url.replace(APIFY_TOKEN || '', 'REDACTED'));

const response = await fetch(
  url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to start hashtag scraper: ${response.status} ${errorText}`);
  }

  const data: ApifyRunResponse = await response.json();
  
  return {
    runId: data.data.id,
    datasetId: data.data.defaultDatasetId,
  };
}

export async function startProfileScraper(
  usernames: string[]
): Promise<{ runId: string; datasetId?: string }> {
  const actorId = 'apify~instagram-profile-scraper';
  const input = {
    usernames,
  };

  const response = await fetch(
    `${APIFY_API_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to start profile scraper: ${response.status} ${errorText}`);
  }

  const data: ApifyRunResponse = await response.json();
  
  return {
    runId: data.data.id,
    datasetId: data.data.defaultDatasetId,
  };
}

export async function getRunStatus(
  runId: string
): Promise<{ status: string; datasetId?: string }> {
  const response = await fetch(
    `${APIFY_API_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`,
    { 
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get run status: ${response.status} ${errorText}`);
  }

  const data: ApifyRunStatusResponse = await response.json();
  
  return {
    status: data.data.status,
    datasetId: data.data.defaultDatasetId,
  };
}

export async function getDatasetItems<T = unknown>(
  datasetId: string,
  limit: number = 10000
): Promise<T[]> {
  const response = await fetch(
    `${APIFY_API_BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json&limit=${limit}`
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get dataset items: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data;
}

export function extractUniqueUsernames(posts: HashtagPost[]): string[] {
  const usernamesSet = new Set<string>();
  
  posts.forEach(post => {
    if (post.ownerUsername) {
      usernamesSet.add(post.ownerUsername.toLowerCase());
    }
  });
  
  return Array.from(usernamesSet);
}

export function mapProfileToCreator(profile: InstagramProfile): DiscoveredCreator {
  const username = profile.username || profile.profileName || '';
  const followers = profile.followersCount || profile.followedByCount || profile.subscribersCount || 0;
  const following = profile.followsCount || profile.followingCount || 0;
  const bio = profile.biography || profile.bio || '';
  const website = profile.externalUrl || profile.url || '';
  
  let engagementRate: number | null = null;
  if (profile.latestPosts && profile.latestPosts.length > 0 && followers > 0) {
    const totalEngagement = profile.latestPosts.reduce((sum: number, post: unknown) => {
      const typedPost = post as { likesCount?: number; commentsCount?: number };
      return sum + (typedPost.likesCount || 0) + (typedPost.commentsCount || 0);
    }, 0);
    const avgEngagement = totalEngagement / profile.latestPosts.length;
    engagementRate = (avgEngagement / followers) * 100;
  }
  
  return {
    handle: username,
    fullName: profile.fullName || '',
    bio,
    followerCount: followers,
    followingCount: following,
    postsCount: profile.postsCount || 0,
    engagementRate,
    isVerified: profile.verified || false,
    profileUrl: `https://instagram.com/${username}`,
    profilePicUrl: profile.profilePicUrl || '',
    website,
    isBusinessAccount: profile.isBusinessAccount || false,
    categoryName: profile.businessCategoryName || '',
    latestPosts: (profile.latestPosts || []) as unknown[],
  };
}

/**
 * Starts apify/instagram-post-scraper for one or more profiles.
 *
 * dataDetailLevel defaults to 'basicData'. The actor's own default is
 * 'detailedData', which is a paid add-on adding alt text, latest comments,
 * music info, paid-partnership and video play count. None of the
 * collaboration fields we read (taggedUsers, coauthorProducers, mentions)
 * are documented as detailed-only, so basic is the cheaper default — the
 * process route reports field coverage so this can be verified on a real run.
 */
export async function startPostScraper(
  usernames: string[],
  resultsLimit: number = 12,
  dataDetailLevel: 'basicData' | 'detailedData' = 'basicData'
): Promise<{ runId: string; datasetId?: string }> {
  const actorId = 'apify~instagram-post-scraper';
  const input = { username: usernames, resultsLimit, dataDetailLevel };

  const response = await fetch(
    `${APIFY_API_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to start post scraper: ${response.status} ${errorText}`);
  }

  const data: ApifyRunResponse = await response.json();

  return {
    runId: data.data.id,
    datasetId: data.data.defaultDatasetId,
  };
}

/**
 * Polls a run to completion.
 *
 * Unlike the inline poller in app/api/enrich/process this one is bounded:
 * an Apify run that hangs would otherwise keep a route handler alive until
 * the platform kills it, with no diagnostic.
 */
/**
 * Thrown when we stop waiting on a run that is still going.
 *
 * Carries the runId and datasetId, because the run itself is unaffected by our
 * giving up: it keeps going, finishes, and bills. A "try on haul" search
 * finished successfully in 289s with all 200 results and $0.46 billed, twenty
 * seconds after the caller stopped waiting at 269s, and the data was discarded
 * because nothing recorded where it was.
 *
 * A caller that catches this can record the identifiers and recover the results
 * through the import path instead of paying to scrape them again.
 */
export class ApifyRunTimeout extends Error {
  readonly runId: string;
  readonly datasetId?: string;
  readonly waitedMs: number;
  readonly lastStatus: string;

  constructor(runId: string, datasetId: string | undefined, waitedMs: number, lastStatus: string) {
    super(
      `Stopped waiting on Apify run ${runId} after ${Math.round(waitedMs / 1000)}s ` +
      `(last status ${lastStatus}). The run is still going and will bill. ` +
      `Dataset ${datasetId ?? 'unknown'} — recoverable via import, do not re-scrape.`
    );
    this.name = 'ApifyRunTimeout';
    this.runId = runId;
    this.datasetId = datasetId;
    this.waitedMs = waitedMs;
    this.lastStatus = lastStatus;
  }
}

export async function waitForRun(
  runId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ status: string; datasetId?: string }> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  // The dataset id is known from the first poll, long before the run finishes.
  // Held so a timeout can report where the results will be.
  let lastDatasetId: string | undefined;
  let lastStatus = 'UNKNOWN';

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const { status, datasetId } = await getRunStatus(runId);
    lastStatus = status;
    if (datasetId) lastDatasetId = datasetId;

    if (status === 'SUCCEEDED') return { status, datasetId };
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${runId} ${status}`);
    }
  }

  throw new ApifyRunTimeout(runId, lastDatasetId, Date.now() - startedAt, lastStatus);
}


/**
 * Maps a TikTok profile item onto the same creator shape as
 * mapProfileToCreator().
 *
 * Moved here verbatim from app/page.tsx so the server-side import path can
 * reach it — it sat in a client component, which is why every server route so
 * far has been Instagram-only. The field fallbacks look redundant but are not:
 * the actor emits `followers` as a bare number on some builds and as
 * `{ raw }` on others, and the flattened `likes.raw` form appears in dataset
 * exports.
 *
 * isBusinessAccount and categoryName are absent rather than defaulted, because
 * TikTok exposes neither; consumers treat them as optional.
 */
export function mapTikTokProfile(profile: any) {
  const handle = (profile.username || '').toLowerCase();
  return {
    handle,
    // The actor emits `tagline` and `image`; `displayName` and `profileImage`
    // do not exist in its output and always resolved to empty. Confirmed from
    // stored data rather than a run — this same actor has fed the TikTok path
    // since the initial commit, and of 3,458 TikTok-primary creators exactly
    // one had a full_name, against 3,347 of 3,347 with a follower count.
    fullName: profile.displayName || profile.tagline || '',
    bio: (profile.bio || '').slice(0, 500),
    followerCount: profile.followers?.raw || profile.followers || 0,
    followingCount: profile.following?.raw || profile.following || 0,
    postsCount: profile.videos?.raw || profile.videos || 0,
    engagementRate: null,
    isVerified: false,
    profilePicUrl: profile.profileImage || profile.image || '',
    profileUrl: profile.profileUrl || profile.url || `https://tiktok.com/@${handle}`,
    website: '',
    platformData: {
      likes_count: profile['likes.raw'] || profile.likes?.raw || profile.likes_raw || profile.likes || 0,
      video_count: profile['videos.raw'] || profile.videos?.raw || profile.videos_raw || profile.videos || 0,
      tagline: profile.tagline || '',
    },
  };
}


/**
 * TikTok hashtag/keyword search. clockworks~tiktok-scraper.
 *
 * Lifted from app/api/tiktok/start-hashtag-scrape so the server-side Discovery
 * route can call it directly instead of going through an HTTP hop that
 * middleware would redirect to /login on a server-to-server request.
 */
export interface TikTokSearchOptions {
  /**
   * Search free text rather than tags.
   *
   * searchSection '/video' matches video DESCRIPTIONS, which is the point on
   * TikTok: creators write keyword-dense descriptions because TikTok indexes
   * them. '' would return the Top section and '/user' would match account names
   * instead.
   */
  keyword?: boolean;
  /**
   * Optional recency window, e.g. 'THIS_MONTH'. A CHARGED add-on — roughly +35%
   * on the search — and only valid with searchSection '/video'. Left unset by
   * default so the first run has one unverified variable, not two.
   */
  dateFilter?: string;
}

export async function startTikTokHashtagScraper(
  hashtags: string[],
  resultsPerPage: number = 50,
  options: TikTokSearchOptions = {}
): Promise<{ runId: string; datasetId?: string }> {
  const actorId = 'clockworks~tiktok-scraper';
  const input: Record<string, unknown> = options.keyword
    ? {
        searchQueries: hashtags,
        searchSection: '/video',
        resultsPerPage,
        proxyConfiguration: { useApifyProxy: true },
        ...(options.dateFilter ? { videoSearchDateFilter: options.dateFilter } : {}),
      }
    : {
        hashtags,
        resultsPerPage,
        proxyConfiguration: { useApifyProxy: true },
      };

  const response = await fetch(
    `${APIFY_API_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to start TikTok hashtag scraper: ${response.status} ${errorText}`);
  }

  const data: ApifyRunResponse = await response.json();
  return { runId: data.data.id, datasetId: data.data.defaultDatasetId };
}

/**
 * TikTok KEYWORD search. xmolodtsov~tiktok-search-scraper.
 *
 * A different actor from the hashtag path on purpose. clockworks is a hashtag
 * scraper with a search mode bolted on, and it under-reads sparse free-text
 * queries: measured on "miami swim", same day, same term, it returned 11 when
 * asked for 200 and 29 when asked for 50, stopping at whichever page came back
 * empty. Its page logs show the empty pages are flaky responses (retry
 * histograms reaching the 4th and 8th attempt on sparse terms) rather than a
 * real end of results, so where it stops is effectively random.
 *
 * Measured against this actor on that same term and day:
 *
 *   clockworks   29 items   $0.0677   $0.00233/result   104s
 *   xmolodtsov   54 items   $0.0119   $0.00022/result    15s
 *
 * 1.9x the depth, a tenth of the price, seven times faster.
 *
 * The hashtag path stays on clockworks. It works well there — that is what it
 * is built for — and switching it would be an unmeasured change.
 *
 * WHAT THIS COSTS US: the author object carries no bio. clockworks emits
 * authorMeta.signature, which populated discovery_candidates.author_signature
 * for every candidate including free rejects, and was the basis of the
 * bio-location mechanism. That column goes NULL for keyword rows from here on.
 * Accepted deliberately: the bio resolved a location for 18% of candidates and
 * never reached city level. ttSeller is likewise absent.
 */
export interface TikTokKeywordSearchOptions {
  /**
   * ISO 3166-1 alpha-2 country code.
   *
   * DEFAULTS TO UNSET so the first runs can be compared against a pinned
   * value. Note two things before reading a comparison:
   *
   *  1. The actor's OWN default is 'US', so leaving this unset is not
   *     "no region" — it is US. A true comparison sets it to something else.
   *  2. The actor's docs say TikTok keys results off the EXIT IP rather than
   *     off this parameter, so it may do nothing without a matching proxy.
   *     Treat a null result from the comparison as inconclusive, not negative.
   */
  location?: string;
  /**
   * One item per creator, decided server-side.
   *
   * Left false for now. On a sparse term it buys little — a measured run
   * returned 54 items across 45 distinct authors, 1.20 posts/author — but on a
   * broad term it converts a post budget into an author budget, which is what
   * the funnel actually wants. To be tested on a broad term after this lands.
   */
  uniqueAuthors?: boolean;
}

export async function startTikTokKeywordSearch(
  keywords: string[],
  maxItems: number = 100,
  options: TikTokKeywordSearchOptions = {}
): Promise<{ runId: string; datasetId?: string }> {
  const actorId = 'xmolodtsov~tiktok-search-scraper';

  const input: Record<string, unknown> = {
    keywords,
    maxItems,
    // Adds `keyword` and `inputSource` to each item, which is how a result is
    // attributed back to the term that found it when several are in flight.
    includeSearchKeywords: true,
    uniqueAuthors: options.uniqueAuthors === true,
    // Sorting is applied by the actor AFTER fetching — the docs are explicit
    // that TikTok ignores server-side sort — so this reorders what came back
    // rather than changing what is fetched. Left at the default.
    sortType: 'RELEVANCE',
    // `expansion` is deliberately NOT set. Its pools (suggest / hashtag /
    // music) are documented to multiply new creators per keyword by roughly
    // 10x, which is the obvious lever for sparse terms — and a 10x cost
    // multiplier. It wants its own measured change, not a default.
    ...(options.location ? { location: options.location } : {}),
  };

  // relevanceThreshold is NOT set. It applies to the MUSIC expansion pool only
  // — the fraction of a sound's first-page captions that must match before
  // that sound is crawled — so with `expansion` unset it governs nothing. The
  // 0.3 seen on the first console run was the actor's default doing nothing.

  const response = await fetch(
    `${APIFY_API_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to start TikTok keyword search: ${response.status} ${errorText}`);
  }

  const data: ApifyRunResponse = await response.json();
  return { runId: data.data.id, datasetId: data.data.defaultDatasetId };
}

/**
 * TikTok profile lookup. abe~tiktok-profile-scraper, matching the actor the
 * existing /api/tiktok/start-profile-scrape route uses.
 */
export async function startTikTokProfileScraper(
  usernames: string[]
): Promise<{ runId: string; datasetId?: string }> {
  const actorId = 'abe~tiktok-profile-scraper';
  const input = { usernames: usernames.map(u => u.replace(/^@/, '')) };

  const response = await fetch(
    `${APIFY_API_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to start TikTok profile scraper: ${response.status} ${errorText}`);
  }

  const data: ApifyRunResponse = await response.json();
  return { runId: data.data.id, datasetId: data.data.defaultDatasetId };
}
