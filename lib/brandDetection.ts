import type { Partnership } from './types';

const SPONSORSHIP_SIGNALS = [
  '#ad', '#sponsored', '#gifted', '#partner', '#collab', 
  '#brandpartner', '#brandambassador', '#paidpartnership', 
  '#prpackage', '#werbung', '#anzeige',
  'paid partnership', 'gifted by', 'sponsored by', 
  'in collaboration with', 'in kooperation mit'
];

interface HashtagPost {
  ownerUsername: string;
  caption?: string;
  hashtags?: string[];
  sponsoredBy?: string[];
  paidPartnership?: string[];
  taggedUsers?: string[];
  url: string;
  type: string;
  likesCount?: number;
  commentsCount?: number;
  viewsCount?: number;
  timestamp?: string;
}

interface BrandDetection {
  brandHandles: string[];
  detectionSignals: string[];
  detectionConfidence: 'high' | 'medium' | 'low';
  isSponsoredContent: boolean;
}

export function detectBrandsInPost(post: HashtagPost): BrandDetection {
  const brandHandles = new Set<string>();
  const detectionSignals = new Set<string>();
  
  // 1. Check paid partnership fields (highest confidence)
  const paidPartnershipBrands = [
    ...(post.sponsoredBy || []),
    ...(post.paidPartnership || [])
  ].filter(Boolean);
  
  if (paidPartnershipBrands.length > 0) {
    paidPartnershipBrands.forEach(handle => brandHandles.add(handle.toLowerCase().replace('@', '')));
    detectionSignals.add('paid_partnership_label');
  }

  // 2. Check tagged users
  const taggedUsers = post.taggedUsers || [];
if (taggedUsers.length > 0) {
  taggedUsers.forEach(handle => {
    if (typeof handle === 'string') {
      const cleanHandle = handle.toLowerCase().replace('@', '');
      if (cleanHandle !== post.ownerUsername?.toLowerCase()) {
        brandHandles.add(cleanHandle);
        detectionSignals.add('tagged_in_post');
      }
    }
  });
}

  // 3. Extract @mentions from caption
  const caption = post.caption || '';
  const mentionRegex = /@([a-zA-Z0-9._]+)/g;
  let match;
  while ((match = mentionRegex.exec(caption)) !== null) {
    const handle = match[1].toLowerCase();
    if (handle !== post.ownerUsername?.toLowerCase()) {
      brandHandles.add(handle);
      detectionSignals.add('mentioned_in_caption');
    }
  }

  // 4. Check for sponsorship signals
  const textToCheck = `${caption} ${(post.hashtags || []).join(' ')}`.toLowerCase();
  const isSponsoredContent = SPONSORSHIP_SIGNALS.some(signal => 
    textToCheck.includes(signal.toLowerCase())
  );

  if (isSponsoredContent) {
    SPONSORSHIP_SIGNALS.forEach(signal => {
      if (textToCheck.includes(signal.toLowerCase())) {
        detectionSignals.add(signal);
      }
    });
  }

  // 5. Determine confidence level
  let detectionConfidence: 'high' | 'medium' | 'low' = 'low';
  
  if (detectionSignals.has('paid_partnership_label')) {
    detectionConfidence = 'high';
  } else if (
    (detectionSignals.has('tagged_in_post') && detectionSignals.has('mentioned_in_caption')) ||
    (isSponsoredContent && (detectionSignals.has('tagged_in_post') || detectionSignals.has('mentioned_in_caption')))
  ) {
    detectionConfidence = 'high';
  } else if (detectionSignals.has('tagged_in_post') || detectionSignals.has('mentioned_in_caption')) {
    detectionConfidence = 'medium';
  }

  return {
    brandHandles: Array.from(brandHandles),
    detectionSignals: Array.from(detectionSignals),
    detectionConfidence,
    isSponsoredContent
  };
}

export function filterPostsByNiche(posts: HashtagPost[], nicheKeywords: string[]): HashtagPost[] {
  if (nicheKeywords.length === 0) return posts;

  const keywords = nicheKeywords.map(k => k.toLowerCase().trim());
  
  return posts.filter(post => {
    const textToCheck = `${post.caption || ''} ${(post.hashtags || []).join(' ')}`.toLowerCase();
    return keywords.some(keyword => textToCheck.includes(keyword));
  });
}

export function createPartnershipRecords(
  post: HashtagPost,
  brandDetection: BrandDetection,
  discoveredViaHashtag: string
): Partnership[] {
  return brandDetection.brandHandles.map(brandHandle => ({
    creatorHandle: post.ownerUsername,
    brandHandle,
    postUrl: post.url,
    postType: post.type || 'unknown',
    postCaption: post.caption || '',
    postedAt: post.timestamp || new Date().toISOString(),
    likesCount: post.likesCount || 0,
    commentsCount: post.commentsCount || 0,
    viewsCount: post.viewsCount || null,
    detectionSignals: brandDetection.detectionSignals,
    detectionConfidence: brandDetection.detectionConfidence,
    discoveredViaHashtag
  }));
}