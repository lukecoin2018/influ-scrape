/**
 * Place data from a TikTok post, and the per-creator residency signal derived
 * from it — pure, no network, no database.
 *
 * clockworks/tiktok-profile-scraper returns `locationMeta` on post items. It
 * has never been read. Measured across 400 items from 25 completed runs it is
 * present on 8% of posts — but per CREATOR the distribution is bimodal, which
 * is what makes it useful:
 *
 *     creators with >=1 tagged post   6 of 27   22%
 *     creators with >=2 tagged posts  4 of 27   15%
 *     of those 4, all 4 had >=60% of their tags on ONE cityCode
 *
 *     @katnimpa       15/15 tagged, all on 1609348 (Bangkok)
 *     @fleurdumalnyc  15/15 tagged, 13 on New York + 2 on Los Angeles
 *     @mya_babycurls   5/15 tagged,  4 on Orlando
 *
 * Creators either geotag habitually or not at all. For the ~15% who do, a
 * dozen posts on one city code is a residency claim of a kind no bio inference
 * reaches — and unlike a single geotagged post, which only says someone passed
 * through, a dominant distribution says they live there.
 *
 * ── WHY cityCode AND NOT locationName ──────────────────────────────────────
 *
 * locationName is venue-level and noisy. Measured on real data, one New York
 * city code carried both "Fleur du Mal NYC Nolita Boutique" and "Fleur Du Mal";
 * search-side data showed five poiName values collapsing to two city codes for
 * Miami, plus a "Miami" resolving to an address in Italy and a "For You" at a
 * Moscow address. The code is the stable key; the name is decoration.
 *
 * ── THE CODES ARE GEONAMES IDs, MOSTLY ─────────────────────────────────────
 *
 * Verified against the GeoNames dumps rather than assumed:
 *
 *   countryCode  5 of 5 resolved exactly
 *                6252001 United States   2635167 United Kingdom
 *                1605651 Thailand        357994 Egypt        390903 Greece
 *
 *   cityCode     8 of 9 resolved, but AT INCONSISTENT GRANULARITY
 *                5128581 New York City   4167147 Orlando     5368361 Los Angeles
 *                5224151 Providence      2647599 Halton (pop 2,218)
 *                4156326 Frostproof, FL  — while TikTok labelled it "Florida"
 *                1609348 Bangkok         — an ADMIN1 province, not a city
 *                6697808 South Aegean    — an ADMIN1 region, not Naxos
 *                52200211 NOT IN GEONAMES at all (id far outside its range)
 *
 * So a code is stable and joinable, but it is not reliably a city: it may be a
 * region, a village of two thousand people, or nothing GeoNames knows. Resolving
 * one to a NAME needs the cities and admin dumps and still fails sometimes.
 *
 * The consequence for design: group on cityCode for dominance, because identity
 * is all that step needs; use countryCode for the market filter, because that
 * resolved cleanly every time and is the level the market question is asked at.
 */

export interface PostPlace {
  cityCode: string | null;
  countryCode: string | null;
  name: string | null;
  address: string | null;
  city: string | null;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/**
 * locationMeta off one post item, or null when it carried none.
 *
 * Returns null rather than an object of nulls: 92% of posts have no place, and
 * "we looked and found nothing" must not be storable as a place that happens to
 * be blank.
 */
export function extractPostPlace(post: unknown): PostPlace | null {
  if (!post || typeof post !== 'object') return null;
  const lm = (post as Record<string, unknown>).locationMeta as Record<string, unknown> | undefined;
  if (!lm || typeof lm !== 'object') return null;

  const place: PostPlace = {
    cityCode: str(lm.cityCode),
    countryCode: str(lm.countryCode),
    name: str(lm.locationName),
    address: str(lm.address),
    city: str(lm.city),
  };

  // A place with no identifier is not usable for the dominance calculation and
  // is not worth a row.
  if (!place.cityCode && !place.countryCode) return null;
  return place;
}

/** Minimum tagged posts before a distribution means anything. One is a visit. */
export const MIN_TAGGED_POSTS = 2;

/** Share of tagged posts that must fall on the top code. */
export const MIN_DOMINANCE = 0.6;

export interface DerivedPlace {
  cityCode: string | null;
  countryCode: string | null;
  /** Best name seen for the winning code. Decoration; never the join key. */
  name: string | null;
  /** taggedOnTopCode / taggedTotal. */
  confidence: number;
  /** Posts that carried a place. The denominator of `confidence`. */
  taggedPosts: number;
  /** Posts inspected, tagged or not. Context for how thin the evidence is. */
  totalPosts: number;
}

/**
 * The per-creator residency signal, or null when the evidence is too thin.
 *
 * Deliberately returns null rather than a low-confidence answer. A creator with
 * one geotagged post has told us they were somewhere once, and writing that
 * down as their location would be exactly the tourist-for-resident error this
 * whole line of work exists to avoid.
 *
 * Country is taken from the WINNING city's posts rather than counted
 * separately. A creator splitting time between New York and Los Angeles should
 * still resolve to the United States, and taking the country of the dominant
 * city gets that right without a second vote that could disagree with the first.
 */
export function derivePlaceFromPosts(
  places: (PostPlace | null)[],
  opts: { minTagged?: number; minDominance?: number } = {},
): DerivedPlace | null {
  const minTagged = opts.minTagged ?? MIN_TAGGED_POSTS;
  const minDominance = opts.minDominance ?? MIN_DOMINANCE;

  const totalPosts = places.length;
  const tagged = places.filter((p): p is PostPlace => p !== null && p.cityCode !== null);
  if (tagged.length < minTagged) return null;

  const counts = new Map<string, number>();
  for (const p of tagged) counts.set(p.cityCode!, (counts.get(p.cityCode!) ?? 0) + 1);

  // Deterministic on a tie: highest count, then lowest code. Without the
  // tiebreak the winner would depend on Map insertion order, i.e. on the order
  // the actor happened to return posts in.
  const [topCode, topCount] = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0];

  const confidence = topCount / tagged.length;
  if (confidence < minDominance) return null;

  const onTop = tagged.filter(p => p.cityCode === topCode);
  return {
    cityCode: topCode,
    countryCode: onTop.find(p => p.countryCode)?.countryCode ?? null,
    name: onTop.find(p => p.city)?.city ?? onTop.find(p => p.name)?.name ?? null,
    confidence,
    taggedPosts: tagged.length,
    totalPosts,
  };
}
