import { normaliseHandleToken } from './handles';

/**
 * Author handles from a hashtag or keyword scrape result — pure, platform-aware.
 *
 * Replaces the accessor chain the Discovery page used:
 *
 *   p.ownerUsername || p.authorMeta?.name || p.uniqueId || ''
 *
 * That chain tried every shape on every platform, which looks tolerant and is
 * not: it silently accepted whichever field happened to exist, so a change in
 * actor output would degrade the result rather than fail. Being explicit per
 * platform means an empty result is visible as an empty result.
 *
 * ── Shape notes for xmolodtsov/tiktok-search-scraper ────────────────────────
 *
 * Only `channel.username` is read here, so the rest of its differences do not
 * bite THIS module. They will bite whatever reads its captions next, so they
 * are recorded where that reader will look:
 *
 *   caption    is `title`, not `text` (clockworks) or `caption` (Instagram)
 *   hashtags   contains literal nulls — measured on 11% of items, e.g.
 *              ["", null, null, "fashion", ...]. Filter before mapping or
 *              `.toLowerCase()` throws.
 *   poi        a geotag object; see extractPoiByHandle in tiktokAuthorMeta.ts
 *   no bio     the channel object carries no signature/bio field at all
 */

/**
 * xmolodtsov/tiktok-search-scraper puts the poster in `channel.username`.
 *
 * A DIFFERENT shape from clockworks, which is why extraction now branches on
 * the pair (platform, searchSource) rather than on platform alone. `channel`
 * also carries a real username rather than a display name, so there is no
 * truncation hazard here — the "@Chester Cheetah" -> "chester" problem that
 * detailedMentions exists to solve on the other actor does not arise.
 */
function tiktokSearchAuthor(post: Record<string, unknown>): unknown {
  const channel = post.channel as Record<string, unknown> | undefined;
  return channel?.username;
}

/** apify/instagram-hashtag-scraper puts the poster in `ownerUsername`. */
function instagramAuthor(post: Record<string, unknown>): unknown {
  return post.ownerUsername
    ?? (post.owner as Record<string, unknown> | undefined)?.username;
}

/**
 * clockworks/tiktok-scraper puts the poster in `authorMeta.name`.
 *
 * `authorMeta.nickName` is the DISPLAY name and must not be used as a handle —
 * that conflation is what produced the stored fragments "levi", "lor" and
 * "the" from captions.
 */
function tiktokAuthor(post: Record<string, unknown>): unknown {
  const authorMeta = post.authorMeta as Record<string, unknown> | undefined;
  const author = post.author as Record<string, unknown> | undefined;
  return authorMeta?.name ?? author?.uniqueId ?? post.uniqueId;
}

/**
 * Which actor produced these posts.
 *
 * Three combinations exist, not four: Instagram uses one actor for both
 * sources, TikTok uses clockworks for hashtags and xmolodtsov for keywords.
 * Naming the pair rather than the platform is what stops a shape change being
 * mistaken for an empty result — see the header.
 */
export type PostSource = 'hashtag' | 'keyword';

export function extractAuthorHandles(
  posts: unknown[],
  platform: 'instagram' | 'tiktok',
  /**
   * Defaults to 'hashtag' so existing callers keep the previous behaviour
   * exactly. Only TikTok keyword search reads a different field.
   */
  source: PostSource = 'hashtag',
): string[] {
  const seen = new Set<string>();

  for (const raw of posts) {
    if (!raw || typeof raw !== 'object') continue;
    const post = raw as Record<string, unknown>;

    const value = platform === 'tiktok'
      ? (source === 'keyword' ? tiktokSearchAuthor(post) : tiktokAuthor(post))
      : instagramAuthor(post);
    const handle = normaliseHandleToken(value);
    if (handle) seen.add(handle);
  }

  return [...seen];
}
