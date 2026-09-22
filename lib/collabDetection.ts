import { isLikelyBrand } from './brandDetection';
import { extractMentionsFromCaption, handlesFromActorList } from './handles';

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
 *
 * Two platforms, two detectors, one output shape. Instagram posts carry three
 * structured collaboration channels (coauthor, tag, mention); TikTok posts
 * carry one (detailedMentions), and the caption is never read there — see
 * detectCollabsInTikTokBrandPost for why.
 */

// ── Signals ───────────────────────────────────────────────────────────────────

/** Instagram's explicit "Collab" feature — the partner co-owns the post. */
export const SIGNAL_COAUTHOR = 'coauthored_post';
/** Creator tagged in the photo/video by the brand. */
export const SIGNAL_TAGGED = 'tagged_in_brand_post';
/** Creator @mentioned in the brand's caption. */
export const SIGNAL_MENTIONED = 'mentioned_in_brand_caption';
/**
 * Creator @mentioned in a brand's TikTok post, read from the actor's resolved
 * detailedMentions — a username, not caption text. Distinct from
 * SIGNAL_MENTIONED so the two platforms' evidence can be told apart on the
 * edge: an Instagram caption mention and a TikTok resolved mention are not the
 * same quality of signal.
 */
export const SIGNAL_MENTIONED_TIKTOK = 'mentioned_in_brand_post';
/**
 * The same creator mentioned in two or more of the brand's posts in one
 * scrape. Corroboration across posts is TikTok's stand-in for Instagram's
 * corroboration across channels.
 */
export const SIGNAL_REPEATED = 'repeated_across_posts';

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

/**
 * The subset of clockworks/tiktok-profile-scraper output this module reads.
 * Field names verified against a real dataset in commit c3b6f16, where the
 * same 13 posts were diffed across clockworks and xmolodtsov and agreed, and
 * again on 2026-09-22 against a 12-post clockworks run of @rhode.
 */
export interface TikTokBrandFeedPost {
  id?: string;
  text?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  createTime?: number;
  diggCount?: number;
  commentCount?: number;
  playCount?: number;
  /** { name, id, ... } per mentioned account; `name` is the username. */
  detailedMentions?: unknown[];
  /** Display names, e.g. "@Huda Beauty". Never read; see the detector. */
  mentions?: unknown[];
  authorMeta?: { name?: string };
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

/**
 * Caption mentions, through the shared pattern in lib/handles.ts.
 *
 * This used to be a private /@[a-zA-Z0-9._]+/g, which truncates rather than
 * rejects: "@loréal" became "lor", "@kiehl's" became "kiehl". The shared
 * pattern requires the match to END at a word boundary, so those yield
 * nothing. What it still cannot fix is a display name split by a space —
 * "@Huda Beauty" legitimately terminates at the space and yields "huda".
 * Instagram autocompletes real handles into captions, so that case is rare
 * there; on TikTok it is the norm, which is why the TikTok detector never
 * reads the caption at all.
 */
const mentionsFromCaption = extractMentionsFromCaption;

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

// ── Instagram ─────────────────────────────────────────────────────────────────

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

// ── TikTok ────────────────────────────────────────────────────────────────────

/**
 * Extracts creator collaboration candidates from a single TikTok brand post.
 *
 * ONE source, and only one: detailedMentions[].name. TikTok has no coauthor
 * or tagged-people equivalent in the actor's output, and the other two
 * mention-shaped fields are not usable:
 *
 *   - `mentions[]` holds display names ("@Huda Beauty", "@RUFFLES"), which
 *     yield fragments ("huda") or the wrong account ("ruffles" for an account
 *     called officialruffles). The Enrich route falls back to it when
 *     detailedMentions is absent; this detector does not, because a brand-feed
 *     candidate becomes a paid profile scrape and a permanent edge, and a
 *     fragment there is exactly the defect docs/tiktok-truncation-repair.md
 *     cost $4.68 to undo.
 *   - The caption renders mentions as display names too, so a regex over it
 *     produces the same fragments.
 *
 * So when detailedMentions is absent or empty the post yields nothing, and
 * summariseTikTokFieldCoverage reports how often that happened. An actor
 * returning an empty array is reporting "no mentions" and is not
 * second-guessed.
 *
 * A single mention is medium confidence: on TikTok a brand @mentioning an
 * account in its own post is the collaboration marker (there is no weaker
 * "tag" to rank it against), but brands also mention sibling accounts and
 * music artists. applyRepeatMentionConfidence lifts a handle seen in two or
 * more posts to high.
 */
export function detectCollabsInTikTokBrandPost(
  post: TikTokBrandFeedPost,
  brandHandle: string
): BrandPostCollabs {
  const caption = post.text || '';
  const brand = (brandHandle || '').toLowerCase().replace(/^@/, '');
  const owner = (post.authorMeta?.name || '').toLowerCase().replace(/^@/, '');

  const handles = Array.isArray(post.detailedMentions)
    ? handlesFromActorList(post.detailedMentions)
    : [];

  const seen = new Set<string>();
  const candidates: CollabCandidate[] = [];
  for (const handle of handles) {
    if (handle === brand || handle === owner || seen.has(handle)) continue;
    seen.add(handle);
    candidates.push({ handle, signals: [SIGNAL_MENTIONED_TIKTOK], confidence: 'medium' });
  }

  const postUrl = post.webVideoUrl
    || (owner && post.id ? `https://www.tiktok.com/@${owner}/video/${post.id}` : '');

  const postedAt = post.createTimeISO
    ? toIsoTimestamp(post.createTimeISO)
    : toIsoTimestamp(post.createTime);

  return {
    postUrl,
    postType: 'video',
    postCaption: caption,
    postedAt,
    likesCount: post.diggCount || 0,
    commentsCount: post.commentCount || 0,
    viewsCount: post.playCount ?? null,
    candidates,
  };
}

/**
 * Lifts a handle that appears in two or more of a brand's posts to high
 * confidence, adding SIGNAL_REPEATED to each of its candidate entries.
 *
 * Applied over the whole scrape rather than inside the per-post detector
 * because the evidence is cross-post. Counts POSTS, not entries: a handle can
 * appear once per post at most after the detector's dedupe, so the two are
 * the same, but the intent is "seen again in another post". Handles already
 * at high are left alone; nothing is ever lowered.
 */
export function applyRepeatMentionConfidence(perPost: BrandPostCollabs[]): BrandPostCollabs[] {
  const postsPerHandle = new Map<string, number>();
  for (const post of perPost) {
    for (const candidate of post.candidates) {
      postsPerHandle.set(candidate.handle, (postsPerHandle.get(candidate.handle) ?? 0) + 1);
    }
  }

  return perPost.map(post => ({
    ...post,
    candidates: post.candidates.map(candidate => {
      if ((postsPerHandle.get(candidate.handle) ?? 0) < 2) return candidate;
      return {
        ...candidate,
        signals: candidate.signals.includes(SIGNAL_REPEATED)
          ? candidate.signals
          : [...candidate.signals, SIGNAL_REPEATED],
        confidence: 'high',
      };
    }),
  }));
}

// ── Coverage ──────────────────────────────────────────────────────────────────

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

/**
 * The TikTok equivalent. Two counts for detailedMentions on purpose:
 * `withDetailedMentionsField` says the actor RETURNED the field (even empty),
 * `withDetailedMentions` says it was non-empty. A run where the first is far
 * below `posts` means the actor stopped emitting the field, which is the one
 * silent failure this detector cannot distinguish from "brand mentions
 * nobody" without this number.
 */
export function summariseTikTokFieldCoverage(posts: TikTokBrandFeedPost[]) {
  return {
    posts: posts.length,
    withDetailedMentionsField: posts.filter(p => Array.isArray(p.detailedMentions)).length,
    withDetailedMentions: posts.filter(
      p => Array.isArray(p.detailedMentions) && p.detailedMentions.length > 0
    ).length,
    withMentions: posts.filter(p => Array.isArray(p.mentions) && p.mentions.length > 0).length,
    withCaption: posts.filter(p => (p.text || '').length > 0).length,
  };
}
