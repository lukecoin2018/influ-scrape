import type { Partnership } from './types';

const SPONSORSHIP_SIGNALS = [
  '#ad', '#sponsored', '#gifted', '#partner', '#collab', 
  '#brandpartner', '#brandambassador', '#paidpartnership', 
  '#prpackage', '#werbung', '#anzeige',
  'paid partnership', 'gifted by', 'sponsored by', 
  'in collaboration with', 'in kooperation mit'
];

// ── Noise filter ───────────────────────────────────────────────────────────────

/**
 * Returns false only for single-character handles (e.g. "h", "k", "l").
 * Everything else is passed through — further validation should be done
 * via follower count lookup (Layer 3) or manual review.
 */
export function isLikelyBrand(handle: string): boolean {
  const h = handle.toLowerCase().trim();

  // Single character — always junk
  if (h.length <= 1) return false;

  return true;
}

// ── Main detection ─────────────────────────────────────────────────────────────

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
  // These come from Instagram's own label — bypass the noise filter entirely
  const sponsoredBy = Array.isArray(post.sponsoredBy) ? post.sponsoredBy : [];
  const paidPartnership = Array.isArray(post.paidPartnership) ? post.paidPartnership : [];
  const paidPartnershipBrands = [...sponsoredBy, ...paidPartnership].filter(Boolean);
  
  if (paidPartnershipBrands.length > 0) {
    paidPartnershipBrands.forEach(handle => {
      const clean = handle.toLowerCase().replace('@', '');
      if (clean !== post.ownerUsername?.toLowerCase()) {
        brandHandles.add(clean);
      }
    });
    detectionSignals.add('paid_partnership_label');
  }

  // 2. Check for sponsorship signals in caption + hashtags
  const caption = post.caption || '';
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

  // 3. Check tagged users
  // Only treat tagged accounts as brand candidates if the post is sponsored.
  // In non-sponsored posts, tagged users are typically photographers, friends,
  // or fellow creators — not brands.
  const taggedUsers = Array.isArray(post.taggedUsers) ? post.taggedUsers : [];
  if (isSponsoredContent && taggedUsers.length > 0) {
    taggedUsers.forEach(handle => {
      if (typeof handle === 'string') {
        const clean = handle.toLowerCase().replace('@', '');
        if (clean !== post.ownerUsername?.toLowerCase() && isLikelyBrand(clean)) {
          brandHandles.add(clean);
          detectionSignals.add('tagged_in_post');
        }
      }
    });
  }

  // 4. Extract @mentions from caption
  // Same logic: only treat mentions as brands if the post is sponsored.
  const mentionRegex = /@([a-zA-Z0-9._]+)/g;
  let match;
  while ((match = mentionRegex.exec(caption)) !== null) {
    const handle = match[1].toLowerCase();
    if (
      handle !== post.ownerUsername?.toLowerCase() &&
      isSponsoredContent &&
      isLikelyBrand(handle)
    ) {
      brandHandles.add(handle);
      detectionSignals.add('mentioned_in_caption');
    }
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