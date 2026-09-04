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
 * A city code, or null when the actor is saying "no city".
 *
 * The actor sends the literal string "0" on country-level tags. Observed on
 * @donnacayman, whose three geotagged posts all read:
 *
 *   {"address":"British Virgin Islands","city":"","cityCode":"0",
 *    "countryCode":"3577718","locationName":"Spanish Town"}
 *
 * GeoNames ids start at 1, so "0" cannot be a place. Left as-is it is a VALUE
 * rather than an absence, and every creator tagged at country level anywhere
 * on earth collapses into one bogus "city 0" bucket in any GROUP BY.
 */
const cityCode = (v: unknown): string | null => {
  const s = str(v);
  return s === null || s === '0' ? null : s;
};

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
    cityCode: cityCode(lm.cityCode),
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
  /**
   * Null on a COUNTRY-LEVEL answer — see the fallback in derivePlaceFromPosts.
   * Null here does not mean "no place"; the whole object is null in that case.
   */
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
  /**
   * How specific the answer is.
   *
   * 'city'    a dominant cityCode was found
   * 'country' no dominant city, but a dominant countryCode — the case the
   *           actor's "0" sentinel produces, where it tagged a country and
   *           named no city
   */
  level: 'city' | 'country';
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

  /** Highest count wins; lowest code breaks a tie, so the answer never depends
   *  on the order the actor returned posts in. */
  const dominant = (values: string[]): [string, number] | null => {
    if (!values.length) return null;
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0];
  };

  // ── City level, preferred ────────────────────────────────────────────────
  const cityTagged = places.filter((p): p is PostPlace => p !== null && p.cityCode !== null);
  if (cityTagged.length >= minTagged) {
    const top = dominant(cityTagged.map(p => p.cityCode!));
    if (top) {
      const [topCode, topCount] = top;
      const confidence = topCount / cityTagged.length;
      if (confidence >= minDominance) {
        const onTop = cityTagged.filter(p => p.cityCode === topCode);
        return {
          cityCode: topCode,
          countryCode: onTop.find(p => p.countryCode)?.countryCode ?? null,
          name: onTop.find(p => p.city)?.city ?? onTop.find(p => p.name)?.name ?? null,
          confidence,
          taggedPosts: cityTagged.length,
          totalPosts,
          level: 'city',
        };
      }
    }
  }

  // ── Country level, fallback ──────────────────────────────────────────────
  //
  // Reached when the actor tagged a country and named no city — it sends
  // cityCode "0" for that, which extractPostPlace turns into null. Without
  // this branch those creators are discarded, which throws away a correct
  // answer: @donnacayman has three posts all tagged British Virgin Islands
  // (countryCode 3577718) and no city on any of them.
  //
  // Also catches a creator who moves between cities within one country — the
  // city vote fails the dominance bar, the country vote does not.
  //
  // Country is the market-facing field anyway, per the GeoNames audit: country
  // codes resolved 5 of 5 and then 8 of 8, while city codes resolve at
  // inconsistent granularity or not at all. A country-level answer is less
  // specific, not less trustworthy.
  const countryTagged = places.filter((p): p is PostPlace => p !== null && p.countryCode !== null);
  if (countryTagged.length < minTagged) return null;

  const topCountry = dominant(countryTagged.map(p => p.countryCode!));
  if (!topCountry) return null;
  const [topCC, ccCount] = topCountry;
  const ccConfidence = ccCount / countryTagged.length;
  if (ccConfidence < minDominance) return null;

  const onCountry = countryTagged.filter(p => p.countryCode === topCC);
  return {
    cityCode: null,
    countryCode: topCC,
    name: onCountry.find(p => p.city)?.city ?? onCountry.find(p => p.name)?.name ?? null,
    confidence: ccConfidence,
    taggedPosts: countryTagged.length,
    totalPosts,
    level: 'country',
  };
}
