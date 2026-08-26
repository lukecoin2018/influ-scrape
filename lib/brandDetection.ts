import type { Partnership } from './types';
import { findMentionsInCaption, normaliseHandleToken } from './handles';

// ── TikTok LIVE exclusions ─────────────────────────────────────────────────────
// These hashtags indicate TikTok's own creator incentive programs — the creator
// is paid by TikTok to go live, not by a brand. No brand to detect. Skip entirely.
const TIKTOK_LIVE_HASHTAGS = new Set([
  'liveincentiveprogram', 'golivegrowfast', 'livebringfans', 'liveiseasy',
  'livestory', 'livehighlights', 'livetips', 'tiktoklive', 'livegift',
  'livehost', 'golive',
]);

// ── Marketing industry exclusions ─────────────────────────────────────────────
// Professionals talking about the ad industry — not sponsored posts.
const MARKETING_INDUSTRY_HASHTAGS = new Set([
  'adagency', 'advertisingagency', 'advertisingindustry', 'holdingcompany',
  'metaads', 'facebookads', 'googleads', 'performancemarketing', 'mediaplanning',
  'programmatic', 'adtech', 'martech', 'ppc', 'sem', 'digitalmarketing',
]);

// ── Strong sponsorship signals ─────────────────────────────────────────────────
// These are reliable on their own — a post with any of these is almost certainly
// a paid partnership.
// Covers 12 languages: EN, DE, ES, FR, IT, PT, NL, PL, SV, NO, DA, ET.
// Hashtags are stored WITHOUT the # prefix in the DB hashtags array.

const SPONSORSHIP_HASHTAGS = new Set([
  // ── English ──────────────────────────────────────────────────────────────────
  'ad', 'sponsored', 'gifted', 'partner', 'collab', 'brandpartner',
  'brandambassador', 'paidpartnership', 'paidcollab',
  'prpackage', 'prhaul', 'prmail', 'spon', 'prproduct', 'prgift',

  // ── German ───────────────────────────────────────────────────────────────────
  'werbung', 'anzeige', 'kooperation', 'zusammenarbeit', 'produktplatzierung',
  'werbepartner', 'kooperationspost', 'gesponsert', 'bezahltekooperation',

  // ── Spanish (ES + LATAM) ─────────────────────────────────────────────────────
  'publicidad', 'publi', 'patrocinado', 'patrocinada', 'colaboracion',
  'colaboración', 'embajadora', 'embajador', 'enviadopor',

  // ── French ───────────────────────────────────────────────────────────────────
  'partenariat', 'publicite', 'publicité', 'sponsorise', 'sponsorisé',
  'offert', 'partenaire',

  // ── Italian ──────────────────────────────────────────────────────────────────
  'pubblicita', 'pubblicità', 'sponsorizzato', 'collaborazione',
  'adv', 'omaggio', 'regalato', 'inpartnership',

  // ── Portuguese (PT + BR) ─────────────────────────────────────────────────────
  'publicidade', 'parceria', 'colaboracao', 'colaboração',
  'parceiro', 'parceira',

  // ── Dutch ────────────────────────────────────────────────────────────────────
  'samenwerking', 'betaaldesamenwerking', 'advertentie', 'reclame', 'gesponsord',

  // ── Polish ───────────────────────────────────────────────────────────────────
  'reklama', 'wspolpraca', 'współpraca', 'sponsorowane', 'partnerstwo',

  // ── Swedish ──────────────────────────────────────────────────────────────────
  'reklam', 'samarbete', 'betaltsamarbete', 'annons',

  // ── Norwegian ────────────────────────────────────────────────────────────────
  'reklame', 'samarbeid', 'betaltsamarbeid', 'annonse',

  // ── Danish ───────────────────────────────────────────────────────────────────
  'samarbejde', 'betaltsamarbejde', 'annonce',

  // ── Estonian ─────────────────────────────────────────────────────────────────
  'reklaam', 'koostoo', 'reklaamkoostoo',
]);

// ── Strong phrases ────────────────────────────────────────────────────────────
// These are specific enough to be reliable without needing a @mention alongside.

const SPONSORSHIP_PHRASES = [
  // ── English ──────────────────────────────────────────────────────────────────
  'paid partnership', 'gifted by', 'sponsored by', 'in collaboration with',
  'in partnership with', 'collab with', 'partnering with', 'teaming up with',
  'in collab with', 'ad |', '| ad', '[ad]', '(ad)',
  ' c/o ', 'c/o @',

  // ── German ───────────────────────────────────────────────────────────────────
  'in kooperation mit', 'in zusammenarbeit mit', 'gesponsert von',
  'in partnerschaft mit',

  // ── Spanish ──────────────────────────────────────────────────────────────────
  'en colaboración con', 'en colaboracion con', 'patrocinado por',
  'patrocinada por', 'regalo de', 'enviado por', 'me enviaron',
  'en partnership con', 'en asociación con', 'en asociacion con',

  // ── French ───────────────────────────────────────────────────────────────────
  'en partenariat avec', 'en collaboration avec', 'offert par',
  'sponsorisé par', 'sponsorise par', 'en association avec',

  // ── Italian ──────────────────────────────────────────────────────────────────
  'in collaborazione con', 'sponsorizzato da', 'offerto da',
  'in partnership con', 'regalo di',

  // ── Portuguese ───────────────────────────────────────────────────────────────
  'em parceria com', 'em colaboração com', 'em colaboracao com',
  'presente de', 'parceria com',

  // ── Dutch ────────────────────────────────────────────────────────────────────
  'in samenwerking met', 'gesponsord door', 'met dank aan',

  // ── Polish ───────────────────────────────────────────────────────────────────
  'we współpracy z', 'we wspolpracy z', 'sponsorowane przez', 'partnerstwo z',

  // ── Swedish ──────────────────────────────────────────────────────────────────
  'i samarbete med', 'sponsrad av',

  // ── Norwegian ────────────────────────────────────────────────────────────────
  'i samarbeid med', 'sponset av',

  // ── Danish ───────────────────────────────────────────────────────────────────
  'i samarbejde med', 'sponsoreret af',

  // ── Estonian ─────────────────────────────────────────────────────────────────
  'koostöö', 'koostoo', 'reklaamkoostöö',
];

// ── Weak phrases ──────────────────────────────────────────────────────────────
// These are ONLY treated as sponsorship signals if a @mention also exists
// in the caption. Without a @mention they fire too many false positives.
// e.g. "gracias a Colombia" ❌  vs  "gracias a @zara" ✓
// e.g. "thank you to everyone" ❌  vs  "thank you to @brand" ✓

const WEAK_SPONSORSHIP_PHRASES = [
  // English
  'thank you to', 'thanks to', 'working with',
  // German
  'vielen dank an', 'danke an',
  // Spanish
  'gracias a',
  // French
  'grâce à', 'grace a', 'merci à', 'merci a',
  // Italian
  'grazie a',
  // Portuguese
  'obrigada a', 'obrigado a', 'apoio de',
  // Swedish
  'tack till',
  // Norwegian
  'takk til',
  // Danish
  'tak til',
];

// ── Noise filter ───────────────────────────────────────────────────────────────

export function isLikelyBrand(handle: string): boolean {
  const h = handle.toLowerCase().trim();
  if (h.length <= 1) return false;
  if (/^\d+$/.test(h)) return false;
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Returns true if this post is a TikTok LIVE incentive post (paid by TikTok,
 * not by a brand). These should be excluded from brand detection entirely.
 */
function isTikTokLivePost(hashtagsLower: string[]): boolean {
  return hashtagsLower.some(h => TIKTOK_LIVE_HASHTAGS.has(h));
}

/**
 * Returns true if this post is a marketing professional talking about their
 * industry — not a sponsored post.
 */
function isMarketingIndustryPost(hashtagsLower: string[]): boolean {
  const matchCount = hashtagsLower.filter(h => MARKETING_INDUSTRY_HASHTAGS.has(h)).length;
  // Require 2+ industry hashtags to avoid false positives on legitimate ad posts
  return matchCount >= 2;
}

/**
 * Detects "x @brand" or "× @brand" pattern common in fashion/lifestyle posts.
 * e.g. "summer look x @zara" or "outfit × @commense.official"
 */
function extractXPatternMentions(caption: string): string[] {
  const results: string[] = [];
  // Same trailing boundary as every other mention match: without it
  // "x @Rare Beauty" yields the fragment "rare".
  const xPattern = /(?:^|\s)[xX×]\s*@([a-zA-Z0-9._]+)(?![A-Za-z0-9\u00C0-\u024F'\u2019-])/g;
  let match;
  while ((match = xPattern.exec(caption)) !== null) {
    const handle = normaliseHandleToken(match[1]);
    if (handle) results.push(handle);
  }
  return results;
}

/**
 * Detects "@handle <collaboration word>" pattern.
 * e.g. "@stockmann_eesti koostöö" or "@brand collab" or "@brand samenwerking"
 * HIGH confidence — explicit in-caption brand disclosure.
 */
function extractMentionCollabPatterns(caption: string): string[] {
  const collabWords = [
    // English
    'collab', 'collaboration', 'partnership', 'partner', 'sponsored',
    'gifted', 'ad', 'ambassador',
    // German
    'werbung', 'anzeige', 'kooperation', 'zusammenarbeit',
    // Spanish
    'publicidad', 'publi', 'colaboracion', 'colaboración', 'patrocinado',
    'patrocinada', 'embajadora', 'embajador',
    // French
    'partenariat', 'sponsorisé', 'sponsorise',
    // Italian
    'collaborazione', 'sponsorizzato', 'pubblicità', 'pubblicita',
    // Portuguese
    'parceria', 'publicidade',
    // Dutch
    'samenwerking', 'gesponsord',
    // Polish
    'współpraca', 'wspolpraca', 'reklama', 'sponsorowane',
    // Swedish
    'samarbete', 'reklam', 'annons',
    // Norwegian
    'samarbeid', 'reklame', 'annonse',
    // Danish
    'samarbejde', 'annonce',
    // Estonian
    'koostöö', 'koostoo', 'reklaam',
  ];
  const results: string[] = [];
  for (const { handle, index, matchLength } of findMentionsInCaption(caption)) {
    const afterHandle = caption.slice(index + matchLength, index + matchLength + 40).toLowerCase();
    const beforeHandle = caption.slice(Math.max(0, index - 20), index).toLowerCase();
    const context = beforeHandle + ' ' + afterHandle;
    if (collabWords.some(word => context.includes(word))) {
      results.push(handle);
    }
  }
  return results;
}

// ── Main detection ─────────────────────────────────────────────────────────────

interface HashtagPost {
  ownerUsername: string;
  caption?: string;
  hashtags?: string[];
  taggedAccounts?: string[];   // maps to creator_posts.tagged_accounts
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

  const caption = post.caption || '';
  const captionLower = caption.toLowerCase();
  const hashtagsLower = (post.hashtags || []).map(h => h.toLowerCase().replace(/^#/, ''));
  const taggedAccounts = Array.isArray(post.taggedAccounts) ? post.taggedAccounts : [];
  const ownerHandle = post.ownerUsername?.toLowerCase() || '';
  const captionHasMention = caption.includes('@');

  // ── Gate 1: TikTok LIVE incentive posts — skip entirely ─────────────────────
  if (isTikTokLivePost(hashtagsLower)) {
    return { brandHandles: [], detectionSignals: [], detectionConfidence: 'low', isSponsoredContent: false };
  }

  // ── Gate 2: Marketing industry posts — skip entirely ────────────────────────
  if (isMarketingIndustryPost(hashtagsLower)) {
    return { brandHandles: [], detectionSignals: [], detectionConfidence: 'low', isSponsoredContent: false };
  }

  // ── Step 1: Strong hashtag signals ──────────────────────────────────────────
  const matchedHashtags = hashtagsLower.filter(h => SPONSORSHIP_HASHTAGS.has(h));
  if (matchedHashtags.length > 0) {
    matchedHashtags.forEach(h => detectionSignals.add(`#${h}`));
  }

  // ── Step 2: Strong phrase signals in caption ─────────────────────────────────
  const matchedPhrases = SPONSORSHIP_PHRASES.filter(phrase =>
    captionLower.includes(phrase.toLowerCase())
  );
  if (matchedPhrases.length > 0) {
    matchedPhrases.forEach(p => detectionSignals.add(p.trim()));
  }

  // ── Step 3: Weak phrase signals — only fire if @mention also present ─────────
  // Prevents "gracias a Colombia", "thank you to everyone" etc. from triggering.
  if (captionHasMention || taggedAccounts.length > 0) {
    const matchedWeakPhrases = WEAK_SPONSORSHIP_PHRASES.filter(phrase =>
      captionLower.includes(phrase.toLowerCase())
    );
    if (matchedWeakPhrases.length > 0) {
      matchedWeakPhrases.forEach(p => detectionSignals.add(p.trim()));
    }
  }

  // ── Step 4: @mention + collab-word pattern ───────────────────────────────────
  const mentionCollabHandles = extractMentionCollabPatterns(caption);
  if (mentionCollabHandles.length > 0) {
    mentionCollabHandles.forEach(h => {
      if (h !== ownerHandle && isLikelyBrand(h)) {
        brandHandles.add(h);
      }
    });
    detectionSignals.add('mention_collab_pattern');
  }

  // ── Step 5: "x @brand" pattern ───────────────────────────────────────────────
  const xPatternHandles = extractXPatternMentions(caption);
  if (xPatternHandles.length > 0) {
    xPatternHandles.forEach(h => {
      if (h !== ownerHandle && isLikelyBrand(h)) {
        brandHandles.add(h);
      }
    });
    detectionSignals.add('x_brand_pattern');
  }

  const isSponsoredContent = detectionSignals.size > 0;

  // ── Step 6: Tagged accounts (only for sponsored posts) ───────────────────────
  if (isSponsoredContent && taggedAccounts.length > 0) {
    taggedAccounts.forEach(handle => {
      if (typeof handle === 'string') {
        const clean = handle.toLowerCase().replace(/^@/, '');
        if (clean !== ownerHandle && isLikelyBrand(clean)) {
          brandHandles.add(clean);
          detectionSignals.add('tagged_in_post');
        }
      }
    });
  }

  // ── Step 7: @mentions in caption (only for sponsored posts) ──────────────────
  if (isSponsoredContent) {
    // Shared extractor: same character class AND trailing boundary as every
    // other mention path. The previous inline regex had no boundary check, so
    // "@Huda Beauty" in a caption was filed as the brand "huda" — the same
    // display-name truncation that corrupted the TikTok pipeline.
    for (const handle of findMentionsInCaption(caption).map(m => m.handle)) {
      if (handle !== ownerHandle && isLikelyBrand(handle)) {
        brandHandles.add(handle);
        detectionSignals.add('mentioned_in_caption');
      }
    }
  }

  // ── Step 8: Confidence scoring ────────────────────────────────────────────────
  let detectionConfidence: 'high' | 'medium' | 'low' = 'low';

  const hasStrongPhrase = matchedPhrases.length > 0;
  const hasCollabPattern = detectionSignals.has('mention_collab_pattern');
  const hasTagged = detectionSignals.has('tagged_in_post');
  const hasMention = detectionSignals.has('mentioned_in_caption');
  const hasHashtag = matchedHashtags.length > 0;

  if (hasCollabPattern) {
    detectionConfidence = 'high';
  } else if (hasStrongPhrase && (hasTagged || hasMention)) {
    detectionConfidence = 'high';
  } else if (hasHashtag && (hasTagged || hasMention)) {
    detectionConfidence = 'high';
  } else if (hasTagged || hasMention || hasHashtag) {
    detectionConfidence = 'medium';
  }

  return {
    brandHandles: Array.from(brandHandles),
    detectionSignals: Array.from(detectionSignals),
    detectionConfidence,
    isSponsoredContent,
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
    discoveredViaHashtag,
  }));
}
