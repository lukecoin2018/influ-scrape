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
 */

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

export function extractAuthorHandles(
  posts: unknown[],
  platform: 'instagram' | 'tiktok',
): string[] {
  const seen = new Set<string>();

  for (const raw of posts) {
    if (!raw || typeof raw !== 'object') continue;
    const post = raw as Record<string, unknown>;

    const value = platform === 'tiktok' ? tiktokAuthor(post) : instagramAuthor(post);
    const handle = normaliseHandleToken(value);
    if (handle) seen.add(handle);
  }

  return [...seen];
}
