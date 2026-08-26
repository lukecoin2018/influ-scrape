import { isLikelyBrand } from './brandDetection';

/**
 * Brand-feed collaboration detection.
 *
 * This is the mirror image of lib/brandDetection.ts. That module reads a
 * CREATOR's post and asks "which brands are being promoted here"; this one
 * reads a BRAND's own post and asks "which creators is this brand working
 * with".
 *
 * The two cannot share logic, for two reasons:
 *
 *  1. detectBrandsInPost() gates everything behind a sponsorship disclosure
 *     (#ad, "in collaboration with", …). Creators disclose; brands posting on
 *     their own feed do not. Applying those gates here would score almost
 *     every brand post as zero.
 *
 *  2. Its brandHandles output would contain creators when run over a brand
 *     feed — the roles are inverted.
 *
 * Like brandDetection.ts this module is pure: no database access. Filtering
 * candidates against known-brand classifications happens in the route, which
 * has the brand_aliases table available.
 */

// ── Signals ───────────────────────────────────────────────────────────────────

/** Instagram's explicit "Collab" feature — the partner co-owns the post. */
export const SIGNAL_COAUTHOR = 'coauthored_post';
/** Creator tagged in the photo/video by the brand. */
export const SIGNAL_TAGGED = 'tagged_in_brand_post';
/** Creator @mentioned in the brand's caption. */
export const SIGNAL_MENTIONED = 'mentioned_in_brand_caption';

export type CollabConfidence = 'high' | 'medium' | 'low';

// ── Types ─────────────────────────────────────────────────────────────────────

/** The subset of apify/instagram-post-scraper output this module reads. */
export interface BrandFeedPost {
  ownerUsername?: string;
  caption?: string;
  url?: string;
  shortCode?: string;
  type?: string;
  productType?: string;
  timestamp?: string | number;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  /** Objects with a `username`, per the actor's output schema. */
  taggedUsers?: unknown[];
  coauthorProducers?: unknown[];
  /** Pre-parsed caption mentions. Strings in practice; objects tolerated. */
  mentions?: unknown[];
}

export interface CollabCandidate {
  handle: string;
  signals: string[];
  confidence: CollabConfidence;
}

export interface BrandPostCollabs {
  postUrl: string;
  postType: string;
  postCaption: string;
  postedAt: string | null;
  likesCount: number;
  commentsCount: number;
  viewsCount: number | null;
  candidates: CollabCandidate[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Instagram handles are 1–30 chars of [a-zA-Z0-9._]. Callers hand us values
 * from three different shapes (actor objects, actor strings, caption regex
 * captures), so normalise and validate in one place.
 *
 * Trailing dots are stripped: a caption like "thanks @brandname." yields
 * "brandname." from the regex, and a trailing dot is not valid in a handle.
 */
function normaliseHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const handle = raw
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/\.+$/, '');

  if (!handle) return null;
  if (handle.length > 30) return null;
  if (!/^[a-z0-9._]+$/.test(handle)) return null;
  // Shared sanity filter with brandDetection: rejects 1-char and all-numeric
  // tokens. (Named for its original caller; the check itself is generic.)
  if (!isLikelyBrand(handle)) return null;

  return handle;
}

/** Actor arrays hold `{ username }` objects; tolerate bare strings too. */
function handlesFrom(list: unknown[] | undefined): string[] {
  if (!Array.isArray(list)) return [];

  return list
    .map(entry => {
      if (typeof entry === 'string') return normaliseHandle(entry);
      if (entry && typeof entry === 'object') {
        const obj = entry as { username?: unknown; name?: unknown };
        return normaliseHandle(obj.username ?? obj.name);
      }
      return null;
    })
    .filter((h): h is string => h !== null);
}

function mentionsFromCaption(caption: string): string[] {
  const matches = caption.match(/@[a-zA-Z0-9._]+/g) || [];
  return matches
    .map(m => normaliseHandle(m))
    .filter((h): h is string => h !== null);
}

function toIsoTimestamp(timestamp: string | number | undefined): string | null {
  if (timestamp === undefined || timestamp === null || timestamp === '') return null;
  // The actor emits ISO strings; numeric epoch-seconds appear on some builds.
  const date = new Date(typeof timestamp === 'number' ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Confidence from which channels a handle appeared in.
 *
 * A coauthor is Instagram's own structured collaboration marker and is
 * unambiguous on its own. Otherwise corroboration across two channels (tagged
 * AND mentioned) is treated as high, mirroring how detectBrandsInPost()
 * upgrades multi-signal matches. A lone tag is medium — brands also tag
 * photographers, venues and sibling accounts. A lone caption mention is low.
 */
function scoreConfidence(signals: Set<string>): CollabConfidence {
  if (signals.has(SIGNAL_COAUTHOR)) return 'high';
  if (signals.size >= 2) return 'high';
  if (signals.has(SIGNAL_TAGGED)) return 'medium';
  return 'low';
}

// ── Main detection ────────────────────────────────────────────────────────────

/**
 * Extracts creator collaboration candidates from a single brand post.
 *
 * `brandHandle` is excluded from the results, as is the post's own owner —
 * brands tag their own sibling accounts constantly.
 */
export function detectCollabsInBrandPost(
  post: BrandFeedPost,
  brandHandle: string
): BrandPostCollabs {
  const caption = post.caption || '';
  const brand = (brandHandle || '').toLowerCase().replace(/^@/, '');
  const owner = (post.ownerUsername || '').toLowerCase().replace(/^@/, '');

  const signalsByHandle = new Map<string, Set<string>>();

  const record = (handle: string, signal: string) => {
    if (handle === brand || handle === owner) return;
    const existing = signalsByHandle.get(handle);
    if (existing) existing.add(signal);
    else signalsByHandle.set(handle, new Set([signal]));
  };

  handlesFrom(post.coauthorProducers).forEach(h => record(h, SIGNAL_COAUTHOR));
  handlesFrom(post.taggedUsers).forEach(h => record(h, SIGNAL_TAGGED));

  // Prefer the actor's pre-parsed mentions; fall back to parsing the caption
  // ourselves when the field is absent (e.g. on a basicData run).
  const actorMentions = handlesFrom(post.mentions);
  const mentions = actorMentions.length > 0 ? actorMentions : mentionsFromCaption(caption);
  mentions.forEach(h => record(h, SIGNAL_MENTIONED));

  const candidates: CollabCandidate[] = Array.from(signalsByHandle.entries()).map(
    ([handle, signals]) => ({
      handle,
      signals: Array.from(signals),
      confidence: scoreConfidence(signals),
    })
  );

  const postUrl = post.url
    || (post.shortCode ? `https://www.instagram.com/p/${post.shortCode}/` : '');

  return {
    postUrl,
    postType: post.type || post.productType || 'unknown',
    postCaption: caption,
    postedAt: toIsoTimestamp(post.timestamp),
    likesCount: post.likesCount || 0,
    commentsCount: post.commentsCount || 0,
    viewsCount: post.videoPlayCount ?? post.videoViewCount ?? null,
    candidates,
  };
}

/**
 * Which of the actor's collaboration fields actually came back.
 *
 * Used to verify that a `basicData` run still carries taggedUsers /
 * coauthorProducers / mentions before committing to it at full scale —
 * `detailedData` is a paid add-on.
 */
export function summariseFieldCoverage(posts: BrandFeedPost[]) {
  const present = (key: keyof BrandFeedPost) =>
    posts.filter(p => Array.isArray(p[key]) && (p[key] as unknown[]).length > 0).length;

  return {
    posts: posts.length,
    withTaggedUsers: present('taggedUsers'),
    withCoauthorProducers: present('coauthorProducers'),
    withMentions: present('mentions'),
    withCaption: posts.filter(p => (p.caption || '').length > 0).length,
  };
}
