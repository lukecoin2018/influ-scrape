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

// ── German disclosure labels ──────────────────────────────────────────────────
// German creators mark paid posts with a bare WORD, not a hashtag: "Anzeige |",
// "*Werbung", "[anzeige/ad]". Measured 2026-10-11 on the 6,607 stored posts of
// the 212 DACH-or-German profiles: "anzeige" as a word in 386 posts and
// "werbung" in 118, against #anzeige in 7 and #werbung in 39. The word only
// counted when a @mention sat within reach of it (extractMentionCollabPatterns),
// so 345 labelled posts were not flagged.
//
// A label counts only where it is positioned as one — the caption's leading
// word, right after * | [ ( or followed by a colon — never as a word anywhere,
// so "Werbung machen" in running text stays unflagged.

const GERMAN_LABEL_PATTERNS: RegExp[] = [
  // Leading word. Emoji, brackets and punctuation may precede it; # and @ may
  // not, because "#werbung" is a hashtag signal and "@werbung…" is a handle.
  /^[^\p{L}\p{N}#@]*(anzeige|werbung)(?!\p{L})/iu,
  /[*|\[(]\s*(anzeige|werbung)(?!\p{L})/giu,
  /(?<!\p{L})(anzeige|werbung)\s*:/giu,
];

// Instagram's German paid-partnership wording. Bounded on the left so the
// unpaid "unbezahlte Partnerschaft mit" does not contain a match.
const GERMAN_PAID_PHRASE = /(?<!\p{L})bezahlte\s+partnerschaft\s+mit(?!\p{L})/iu;

// Unpaid labels are NOT sponsorship. German creators label brand mentions
// nobody paid for out of legal caution — "unbezahlte Werbung", "Werbung durch
// Markennennung", "keine Werbung, selbst gekauft". 15 such posts in the same
// sample; 5 were being counted as sponsored.
//
// When one is present, the German label words stop counting anywhere in the
// post — as a label, as a hashtag (#werbung) and as a collab word beside a
// mention. Other signals (#ad, "in kooperation mit", a tagged brand) still do.
const GERMAN_UNPAID_PATTERNS: RegExp[] = [
  /(?<!\p{L})unbezahlt/iu,
  /(?<!\p{L})unbeauftragt/iu,
  /marken(?:nennung|erkennung|erwähnung)/iu,
  /(?<!\p{L})keine\s+(?:bezahlte\s+)?(?:werbung|anzeige|kooperation)(?!\p{L})/iu,
  /selbst\s*gekauft/iu,
];

const GERMAN_LABEL_WORDS = ['anzeige', 'werbung'];

export interface GermanDisclosure {
  /** Label words found in a label position, lowercased and de-duplicated. */
  labels: string[];
  /** "bezahlte Partnerschaft mit" is present. */
  paidPhrase: boolean;
  /** An unpaid label is present; the label words above must then be ignored. */
  unpaid: boolean;
}

export function detectGermanDisclosure(caption: string): GermanDisclosure {
  const text = caption || '';
  const labels = new Set<string>();
  for (const pattern of GERMAN_LABEL_PATTERNS) {
    if (pattern.global) {
      for (const m of text.matchAll(pattern)) labels.add(m[1].toLowerCase());
    } else {
      const m = pattern.exec(text);
      if (m) labels.add(m[1].toLowerCase());
    }
  }
  return {
    labels: [...labels].sort(),
    paidPhrase: GERMAN_PAID_PHRASE.test(text),
    unpaid: GERMAN_UNPAID_PATTERNS.some(p => p.test(text)),
  };
}

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
 *
 * `ignoredWords` drops collab words that must not count for this caption —
 * the German label words when the post carries an unpaid label.
 */
function extractMentionCollabPatterns(caption: string, ignoredWords: string[] = []): string[] {
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
  ].filter(word => !ignoredWords.includes(word));
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
  /**
   * Set when taggedAccounts came from a scraper that resolved real usernames,
   * rather than from parsing the caption.
   *
   * TikTok captions render mentions as @DisplayName, so "@Chester Cheetah"
   * yields the fragment "chester" while the actor's detailedMentions gives the
   * real handle "cheetos". With both sources active the post ends up carrying
   * BOTH — the fragment beside the account it is a broken version of, which
   * double-counts the brand and keeps regenerating the fragment on every
   * re-detection pass.
   *
   * When set, caption-derived HANDLES are suppressed in favour of
   * taggedAccounts. Hashtag and phrase signals are unaffected, and the
   * caption-pattern SIGNALS still fire — a collab word next to a mention is
   * evidence of sponsorship regardless of which source names the brand.
   */
  mentionsAreResolved?: boolean;
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
  const mentionsAreResolved = post.mentionsAreResolved === true;
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

  // An unpaid German label switches the German label words off for the whole
  // post — hashtag, label and collab word alike. See GERMAN_UNPAID_PATTERNS.
  const german = detectGermanDisclosure(caption);
  const ignoredLabelWords = german.unpaid ? GERMAN_LABEL_WORDS : [];

  // ── Step 1: Strong hashtag signals ──────────────────────────────────────────
  const matchedHashtags = hashtagsLower.filter(h =>
    SPONSORSHIP_HASHTAGS.has(h) && !ignoredLabelWords.includes(h)
  );
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

  // ── Step 2b: German disclosure labels ────────────────────────────────────────
  // A positioned "Anzeige"/"Werbung" is the German #ad and is scored like one.
  const germanLabels = german.unpaid ? [] : german.labels;
  germanLabels.forEach(w => detectionSignals.add(`label:${w}`));
  const germanPaidPhrase = german.paidPhrase && !german.unpaid;
  if (germanPaidPhrase) detectionSignals.add('bezahlte partnerschaft mit');

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
  // The signal fires either way: a collab word beside a mention is evidence of
  // sponsorship whoever names the brand. Only the handle is withheld when the
  // caption is not the authoritative source for it.
  const mentionCollabHandles = extractMentionCollabPatterns(caption, ignoredLabelWords);
  if (mentionCollabHandles.length > 0) {
    if (!mentionsAreResolved) {
      mentionCollabHandles.forEach(h => {
        if (h !== ownerHandle && isLikelyBrand(h)) {
          brandHandles.add(h);
        }
      });
    }
    detectionSignals.add('mention_collab_pattern');
  }

  // ── Step 5: "x @brand" pattern ───────────────────────────────────────────────
  const xPatternHandles = extractXPatternMentions(caption);
  if (xPatternHandles.length > 0) {
    if (!mentionsAreResolved) {
      xPatternHandles.forEach(h => {
        if (h !== ownerHandle && isLikelyBrand(h)) {
          brandHandles.add(h);
        }
      });
    }
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
  // Skipped entirely when the mentions are resolved: every handle this would
  // produce is a display-name fragment of one already contributed by Step 6,
  // and Step 6's 'tagged_in_post' covers the confidence contribution.
  if (isSponsoredContent && !mentionsAreResolved) {
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

  const hasStrongPhrase = matchedPhrases.length > 0 || germanPaidPhrase;
  const hasCollabPattern = detectionSignals.has('mention_collab_pattern');
  const hasTagged = detectionSignals.has('tagged_in_post');
  const hasMention = detectionSignals.has('mentioned_in_caption');
  const hasHashtag = matchedHashtags.length > 0 || germanLabels.length > 0;

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
