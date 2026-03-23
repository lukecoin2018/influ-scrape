import type { Partnership } from './types';

const SPONSORSHIP_SIGNALS = [
  '#ad', '#sponsored', '#gifted', '#partner', '#collab', 
  '#brandpartner', '#brandambassador', '#paidpartnership', 
  '#prpackage', '#werbung', '#anzeige',
  'paid partnership', 'gifted by', 'sponsored by', 
  'in collaboration with', 'in kooperation mit'
];

// ── Noise filter ───────────────────────────────────────────────────────────────

// Generic English words that appear in captions but are never brand handles
const COMMON_WORDS = new Set([
  'white', 'black', 'blue', 'red', 'green', 'pink', 'gold', 'silver',
  'colour', 'color', 'best', 'salt', 'urban', 'naked', 'whole', 'wild',
  'pure', 'free', 'new', 'real', 'live', 'love', 'life', 'style',
  'shop', 'store', 'brand', 'team', 'post', 'page', 'link', 'bio',
  'model', 'photo', 'video', 'edit', 'film', 'art', 'media', 'group',
  'official', 'original', 'daily', 'world', 'global', 'local', 'studio',
  'house', 'home', 'club', 'lab', 'labs', 'co', 'inc', 'llc',
  'the', 'and', 'for', 'you', 'not', 'but', 'our', 'all', 'its',
  'dark', 'light', 'mini', 'mega', 'super', 'ultra', 'pro', 'plus',
  'soft', 'bold', 'rich', 'cool', 'warm', 'hot', 'fresh', 'clean',
  'wear', 'looks', 'vibes', 'goals', 'inspo', 'mood', 'check',
]);

// Common first names frequently misidentified as brands
const COMMON_FIRST_NAMES = new Set([
  'bella', 'charlotte', 'morgan', 'ryan', 'madison', 'sebastian',
  'emma', 'olivia', 'sophia', 'isabella', 'mia', 'luna', 'grace',
  'chloe', 'avery', 'ella', 'scarlett', 'riley', 'aria', 'lily',
  'zoey', 'victoria', 'aurora', 'savannah', 'claire', 'ellie',
  'liam', 'noah', 'oliver', 'james', 'lucas', 'mason', 'ethan',
  'aiden', 'logan', 'jackson', 'jack', 'owen', 'samuel',
  'henry', 'wyatt', 'carter', 'julian', 'luke', 'grayson', 'leo',
  'hannah', 'zoe', 'nora', 'mila', 'layla', 'camila', 'penelope',
  'alice', 'stella', 'hazel', 'eleanor', 'natalie', 'anna', 'violet',
  'sarah', 'jessica', 'emily', 'ashley', 'taylor', 'samantha', 'rachel',
  'melissa', 'nicole', 'amanda', 'stephanie', 'lisa', 'laura', 'julia',
  'mike', 'david', 'chris', 'daniel', 'matt', 'jason', 'josh',
  'alex', 'kyle', 'tyler', 'brandon', 'justin', 'adam', 'nathan',
  'tom', 'ben', 'max', 'jake', 'sean', 'derek', 'drew', 'evan',
  'sofia', 'leah', 'abigail', 'brooklyn', 'paisley', 'evelyn',
  'aaliyah', 'jade', 'kylie', 'kendall', 'hailey', 'brianna',
]);

// Handle suffixes that strongly indicate a personal/creator account
const PERSONAL_HANDLE_SUFFIXES = [
  '_photography', '_photo', '_photos', '_fotografie',
  '_makeup', '_mua',
  '_hair', '_nails',
  '_fitness', '_fit',
  '_art', '_arts', '_artist', '_arte',
  '_real',
  '_life', '_lifestyle',
  '_blog', '_vlogs', '_vlog',
];

/**
 * Returns true if the handle looks like a real brand account.
 * Returns false if it looks like noise, a common word, a first name,
 * or a personal/creator account handle.
 *
 * Note: paid_partnership_label handles bypass this filter — if Instagram
 * itself labelled it as a paid partnership, we trust that signal.
 */
export function isLikelyBrand(handle: string): boolean {
  const h = handle.toLowerCase().trim();

  // Too short to be a real brand handle
  if (h.length < 3) return false;

  // Purely numeric
  if (/^\d+$/.test(h)) return false;

  // Common English word — not a brand
  if (COMMON_WORDS.has(h)) return false;

  // Common first name alone — not a brand
  if (COMMON_FIRST_NAMES.has(h)) return false;

  // Handle ending with a personal/creator suffix
  if (PERSONAL_HANDLE_SUFFIXES.some(suffix => h.endsWith(suffix))) return false;

  // Pattern like "firstname.lastname" or "firstname_lastname"
  // Only reject if the first segment is a known first name
  const separatorMatch = h.match(/^([a-z]+)[._]([a-z]+)$/);
  if (separatorMatch) {
    const firstName = separatorMatch[1];
    if (COMMON_FIRST_NAMES.has(firstName)) return false;
  }

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