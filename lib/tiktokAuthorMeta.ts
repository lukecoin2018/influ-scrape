import { normaliseHandleToken } from './handles';

/**
 * Author metadata carried on a TikTok search result — pure, no network.
 *
 * clockworks/tiktok-scraper returns authorMeta on the post itself: fans
 * (follower count), signature (bio), ttSeller (TikTok Shop seller),
 * verified, privateAccount. If those are populated on SEARCH results — and
 * that is the thing the first run exists to confirm — the follower band and two
 * business signals move from the paid side of the pipeline to the free side.
 *
 * Instagram has no equivalent. Its hashtag and keyword posts carry
 * ownerUsername, ownerFullName, caption and engagement counts, and nothing
 * about the account behind them, so there the follower band can only be applied
 * after a profile scrape.
 *
 * Declared-but-absent fields have bitten this project repeatedly — displayName
 * and profileImage on the profile actor, taggedAccounts on the hashtag actor —
 * so nothing here assumes presence. Every field is optional, coverage is
 * measured rather than trusted, and the caller decides what to do when it is
 * missing.
 */

export interface SearchAuthorMeta {
  handle: string;
  /** authorMeta.fans. Null when the field is absent, NOT zero. */
  followerCount: number | null;
  signature: string | null;
  ttSeller: boolean | null;
  verified: boolean | null;
  privateAccount: boolean | null;
}

export interface AuthorMetaCoverage {
  /** Items that yielded a handle at all. The denominator. */
  items: number;
  withFollowerCount: number;
  withSignature: number;
  withTtSeller: number;
  withVerified: number;
  /** withFollowerCount / items, 0 when there are no items. */
  followerCountRate: number;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Some builds emit counts as strings.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * One entry per distinct author across the items.
 *
 * Keyed on authorMeta.name, never nickName. nickName is the DISPLAY name — the
 * conflation that produced the stored fragments "levi", "lor" and "the" — and
 * it is not a handle even when it looks like one.
 */
export function extractAuthorMeta(posts: unknown[]): Map<string, SearchAuthorMeta> {
  const byHandle = new Map<string, SearchAuthorMeta>();

  for (const raw of posts) {
    if (!raw || typeof raw !== 'object') continue;
    const meta = (raw as Record<string, unknown>).authorMeta as Record<string, unknown> | undefined;
    if (!meta || typeof meta !== 'object') continue;

    const handle = normaliseHandleToken(meta.name);
    if (!handle) continue;

    const existing = byHandle.get(handle);
    const candidate: SearchAuthorMeta = {
      handle,
      followerCount: num(meta.fans),
      signature: str(meta.signature),
      ttSeller: bool(meta.ttSeller),
      verified: bool(meta.verified),
      privateAccount: bool(meta.privateAccount),
    };

    // A handle appearing on several posts may carry the fields on only some of
    // them. Merge rather than overwrite, so a later bare item cannot erase a
    // reading an earlier one supplied.
    byHandle.set(handle, existing ? {
      handle,
      followerCount: existing.followerCount ?? candidate.followerCount,
      signature: existing.signature ?? candidate.signature,
      ttSeller: existing.ttSeller ?? candidate.ttSeller,
      verified: existing.verified ?? candidate.verified,
      privateAccount: existing.privateAccount ?? candidate.privateAccount,
    } : candidate);
  }

  return byHandle;
}

export function summariseAuthorMetaCoverage(
  metas: Map<string, SearchAuthorMeta>,
): AuthorMetaCoverage {
  const all = [...metas.values()];
  const withFollowerCount = all.filter(m => m.followerCount !== null).length;

  return {
    items: all.length,
    withFollowerCount,
    withSignature: all.filter(m => m.signature !== null).length,
    withTtSeller: all.filter(m => m.ttSeller !== null).length,
    withVerified: all.filter(m => m.verified !== null).length,
    followerCountRate: all.length === 0 ? 0 : withFollowerCount / all.length,
  };
}

/**
 * Below this share of authors carrying a follower count, the pre-scrape filter
 * cannot be trusted and the run halts.
 *
 * Halting rather than falling back is deliberate. A fallback would silently
 * scrape every distinct author — roughly 150 per term at $0.005 each against a
 * handful when the filter works — so the cheaper actor's economics would apply
 * without anyone choosing them. A run that stops and says why costs one search.
 */
export const MIN_FOLLOWER_COVERAGE = 0.5;

export function shouldHaltOnCoverage(coverage: AuthorMetaCoverage): boolean {
  if (coverage.items === 0) return false; // nothing extracted; a different failure
  return coverage.followerCountRate < MIN_FOLLOWER_COVERAGE;
}
