export interface DiscoveryConfig {
    hashtags: string[];
    minFollowers: number;
    maxFollowers: number;
    resultsPerHashtag: number;
  }
  
  export interface PipelineStatus {
    stage: 'idle' | 'hashtags' | 'profiles' | 'filtering' | 'complete' | 'error';
    progress: number;
    message: string;
    stats: {
      postsFound: number;
      uniqueHandles: number;
      profilesScraped: number;
      creatorsInRange: number;
    };
    error?: string;
  }
  
  export interface DiscoveredCreator {
    handle: string;
    fullName: string;
    bio: string;
    followerCount: number;
    followingCount: number;
    postsCount: number;
    engagementRate: number | null;
    isVerified: boolean;
    profileUrl: string;
    profilePicUrl: string;
    website: string;
    isBusinessAccount: boolean;
    categoryName: string;
    latestPosts: unknown[];
  }
  
  export interface ApifyRunResponse {
    data: {
      id: string;
      status: string;
      defaultDatasetId?: string;
    };
  }
  
  export interface ApifyRunStatusResponse {
    data: {
      id: string;
      status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABORTED';
      defaultDatasetId?: string;
    };
  }
  
  export interface HashtagPost {
    ownerUsername: string;
    likes?: number;
    comments?: number;
    caption?: string;
    timestamp?: string;
  }
  
  export interface InstagramProfile {
    username?: string;
    profileName?: string;
    fullName?: string;
    biography?: string;
    bio?: string;
    followersCount?: number;
    followedByCount?: number;
    subscribersCount?: number;
    followsCount?: number;
    followingCount?: number;
    postsCount?: number;
    verified?: boolean;
    isBusinessAccount?: boolean;
    businessCategoryName?: string;
    externalUrl?: string;
    url?: string;
    profilePicUrl?: string;
    latestPosts?: unknown[];
  }