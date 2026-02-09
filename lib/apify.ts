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
  const actorId = 'apify/instagram-hashtag-scraper';
  const input = {
    hashtags,
    resultsLimit,
    searchType: 'hashtag',
    resultsType: 'posts',
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
  const actorId = 'apify/instagram-profile-scraper';
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
    `${APIFY_API_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`
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
  };
}