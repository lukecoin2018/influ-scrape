/**
 * Per-post language from the actor, and the per-creator language derived from
 * it — pure, no network, no database.
 *
 * clockworks/tiktok-profile-scraper returns `textLanguage` on 99% of post
 * items and it has never been read. The pipeline instead runs
 * detectLanguage() — a stopword heuristic over the bio plus five captions — in
 * app/api/intelligence/analyze.
 *
 * Measured on 525 items / 35 creators from completed runs, the actor's answer
 * beats the heuristic:
 *
 *     agree                                     31
 *     disagree                                   3
 *     heuristic blank, actor has an answer       1
 *
 * and in all four non-agreements the actor is the credible one:
 *
 *     @hannapannavattenkanna1  actor sv 93%   heuristic pt
 *     @kleo_tsvk               actor en 80%   heuristic de   (12 en posts vs 3 de)
 *     @bibii.230               actor ro 67%   heuristic fr   (no French posts at all)
 *     @___.vrp2                actor es 100%  heuristic null
 *
 * This matters more than a tidier language column: the market is defined by
 * language more than geography, and this field covers 99% of posts against
 * detected_country's 71% of profiles.
 *
 * ── 'un' IS NOT A LANGUAGE ─────────────────────────────────────────────────
 *
 * 15.6% of posts come back as 'un' — undetermined, typically a caption that is
 * only hashtags or emoji. It must be excluded BEFORE the vote, not counted and
 * then ignored: one measured creator is un:13 de:2, and a naive dominant-value
 * count returns 'un' for them, which is worse than returning nothing.
 *
 * ── RELATIONSHIP TO postLocation ───────────────────────────────────────────
 *
 * Same shape as derivePlaceFromPosts — group, find the dominant value, require
 * a threshold — and deliberately NOT shared with it. The two differ in what
 * they exclude ('un' here, untagged there), in what they carry through
 * alongside the winner (a country code there, nothing here) and in their
 * thresholds. A generic would need an option for each difference and would be
 * longer than both. See docs/deferred-cleanups.md; the trigger for merging
 * them is a third consumer of the same shape.
 */

/** Actor's marker for "could not tell". Never a valid answer. */
export const UNDETERMINED = 'un';

/** Minimum posts carrying a real language before a creator gets one. */
export const MIN_LANGUAGE_POSTS = 3;

/** Share of those posts that must agree. */
export const MIN_LANGUAGE_DOMINANCE = 0.6;

/** The post's language, or null when absent or undetermined. */
export function extractPostLanguage(post: unknown): string | null {
  if (!post || typeof post !== 'object') return null;
  const raw = (post as Record<string, unknown>).textLanguage;
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toLowerCase();
  if (!code || code === UNDETERMINED) return null;
  return code;
}

export interface DerivedLanguage {
  language: string;
  /** postsInWinningLanguage / postsWithAnyLanguage. */
  confidence: number;
  /** Posts that carried a determinable language. */
  languagePosts: number;
  /** Posts inspected, including undetermined ones. */
  totalPosts: number;
  /** Every language seen, most frequent first. A bilingual creator is useful to see. */
  all: string[];
}

/**
 * The per-creator language, or null when the evidence is too thin.
 *
 * Threshold is three posts rather than the two used for place, because a
 * language is cheap to guess wrongly from a short caption and the cost of a
 * wrong answer is a creator filtered out of the wrong market. Place needs only
 * two because a geotag is an explicit act.
 */
export function deriveLanguageFromPosts(
  languages: (string | null)[],
  opts: { minPosts?: number; minDominance?: number } = {},
): DerivedLanguage | null {
  const minPosts = opts.minPosts ?? MIN_LANGUAGE_POSTS;
  const minDominance = opts.minDominance ?? MIN_LANGUAGE_DOMINANCE;

  const totalPosts = languages.length;
  const known = languages.filter((l): l is string => typeof l === 'string' && l !== '');
  if (known.length < minPosts) return null;

  const counts = new Map<string, number>();
  for (const l of known) counts.set(l, (counts.get(l) ?? 0) + 1);

  // Deterministic on a tie — count, then code — so the answer does not depend
  // on the order the actor returned posts in.
  const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  const [language, count] = ranked[0];

  const confidence = count / known.length;
  if (confidence < minDominance) return null;

  return {
    language,
    confidence,
    languagePosts: known.length,
    totalPosts,
    all: ranked.map(([l]) => l),
  };
}
