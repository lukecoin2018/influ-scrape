import { NEAR_MISS_FLOOR } from './followerRange';
import type { ImportPolicy } from './profileImportCore';

export { NEAR_MISS_FLOOR };

/**
 * How Discovery routes a scraped profile, as against how brand-feed does.
 *
 * The archive holds creators who are outside the band but still QUALIFIED.
 * Brand-feed candidates qualify by construction: a brand chose to feature
 * them, so an 18k account on a brand's feed is someone in the business whose
 * partnership edge is real. Hashtag and keyword candidates pass through no
 * selection step at all — somebody with 800 followers who used #grwm is not a
 * creator, they are a person who used a word. Archiving those would fill a
 * table built for one kind of evidence with another, and nothing downstream
 * could tell them apart.
 *
 * So Discovery splits the below-min group at a floor:
 *
 *   >= floor, < min   archived as out_of_range_low, like brand-feed. Near
 *                     misses, and keyword search is expected to surface
 *                     emerging creators no brand has tagged yet.
 *   < floor           cache only. The handle and its follower count are
 *                     recorded so it is never re-scraped, and nothing else.
 *
 * Every other verdict imports, including 'unknown_size': an unmeasured handle
 * has to reach social_profiles for enrichment to re-measure it later.
 *
 * The floor is a guess pending the first instrumented run. Moving it is a
 * one-constant change, but lowering it strands already-cached handles between
 * the old and new values — see docs/deferred-cleanups.md for the query that
 * finds them.
 */
export const discoveryImportPolicy: ImportPolicy = (profile, status) => {
  if (status === 'out_of_range_low' && profile.followerCount < NEAR_MISS_FLOOR) {
    return 'cache_only';
  }
  return 'import';
};
