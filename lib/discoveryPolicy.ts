import type { ImportPolicy } from './profileImportCore';

/**
 * How Discovery routes a scraped profile, as against how brand-feed does.
 *
 * The archive holds creators who are outside the band but still QUALIFIED.
 * Brand-feed candidates qualify by construction: a brand chose to feature them,
 * so an 18k account on a brand's feed is someone in the business who is simply
 * small, and the partnership edge is real evidence about them.
 *
 * Hashtag and keyword candidates pass through no selection step at all. An 18k
 * account that used #grwm is not a small creator — it is an account with 18k
 * followers. Nothing about appearing under a search term says anything about
 * whether the person behind it is in this business.
 *
 * So Discovery archives nothing. Every out-of-range verdict, in EITHER
 * direction, goes to the reject cache: handle, platform, follower count,
 * timestamp. Enough never to pay for that handle again, and no creator record
 * for someone who has not been shown to be one.
 *
 * This replaces a near-miss floor that sent Discovery's 15k-30k candidates to
 * the archive and only cached below that. The floor drew a line inside a
 * population that is uniformly unqualified — a 20k keyword hit is no more a
 * creator than a 12k one — and the archive is not the place for either.
 *
 * Two verdicts still import:
 *
 *   'active'        in band, which is the whole point
 *   'unknown_size'  the follower count was not measured, so no verdict has been
 *                   reached about it. It lands in social_profiles as non-active
 *                   where enrichment can re-measure it. Caching it would file a
 *                   permanent rejection on the strength of a failed scrape.
 */
export const discoveryImportPolicy: ImportPolicy = (_profile, status) => {
  if (status === 'out_of_range_low' || status === 'out_of_range_high') {
    return 'cache_only';
  }
  return 'import';
};
