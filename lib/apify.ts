import type { ApifyRunResponse, ApifyRunStatusResponse, HashtagPost, InstagramProfile, DiscoveredCreator } from './types';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

if (!APIFY_TOKEN) {
  console.warn('WARNING: APIFY_API_TOKEN is not set');
}

export async function startHashtagScraper(
  hashtags: string[],
  resultsLimit: number = 100
): Promise<{ runId: string; datasetId?: string }> {
  const actorId = 'apify~instagram-hashtag-scraper';
  const input = {
    hashtags,
    resultsLimit,
    searchType: 'hashtag',
    resultsType: 'posts',
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
export async function waitForRun(
  runId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ status: string; datasetId?: string }> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const { status, datasetId } = await getRunStatus(runId);

    if (status === 'SUCCEEDED') return { status, datasetId };
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${runId} ${status}`);
    }
  }

  throw new Error(`Apify run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
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
    fullName: profile.displayName || '',
    bio: (profile.bio || '').slice(0, 500),
    followerCount: profile.followers?.raw || profile.followers || 0,
    followingCount: profile.following?.raw || profile.following || 0,
    postsCount: profile.videos?.raw || profile.videos || 0,
    engagementRate: null,
    isVerified: false,
    profilePicUrl: profile.profileImage || '',
    profileUrl: profile.profileUrl || `https://tiktok.com/@${handle}`,
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
export async function startTikTokHashtagScraper(
  hashtags: string[],
  resultsPerPage: number = 50
): Promise<{ runId: string; datasetId?: string }> {
  const actorId = 'clockworks~tiktok-scraper';
  const input = {
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
