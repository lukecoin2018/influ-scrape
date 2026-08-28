import { supabase } from './supabase';
import { looseHandle as norm } from './handles';

/**
 * Entity classification filter — "is this handle an importable creator?"
 *
 * Moved verbatim out of app/api/brand-feed/process/route.ts so hashtag and
 * keyword discovery can run the same gate. The question it answers is not
 * brand-specific: any pipeline that turns scraped handles into creator records
 * wants to drop the accounts that are not creators, and wants to drop them
 * BEFORE paying to scrape their profiles.
 *
 * The only parameter added in the move is `platform`, which selects the column
 * the brands lookup keys on.
 */

/**
 * brand_aliases classifications that are not importable creators.
 * 'creator' and 'unknown' proceed, as do handles with no alias row at all —
 * unknown is genuinely unclassified and excluding it would discard exactly
 * the new creators we are looking for.
 */
export const NON_CREATOR_ENTITY_TYPES = ['brand', 'celebrity', 'media', 'venue', 'fragment'];

/**
 * Only brands rows with real scraped profile data are trusted as a
 * "this is a brand" signal.
 *
 * The other 11,402 rows come from data_source='enrich_pipeline', which files
 * a brands row for every handle any creator ever mentioned. 233 known
 * Instagram creators sit in that set, 220 of them inside a 30k-500k band —
 * excluding on the whole table would blacklist the creators we want.
 */
export const TRUSTED_BRAND_DATA_SOURCES = ['sponsorship_detection'];

/** PostgREST `in.()` lists go in the URL; keep them well short of URL limits. */
const LOOKUP_CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * How the platform affects this filter.
 *
 * brand_aliases has no platform dimension at all — its aliases are bare
 * strings — so the alias half of the filter applies identically to both
 * platforms. That is a deliberate accepted approximation rather than an
 * oversight: measured against the existing profile population, handles that
 * collide with a non-creator alias are 1 of 3,784 on Instagram and 2 of 3,347
 * on TikTok, and both TikTok collisions (a brand account and a media account)
 * are correct exclusions rather than false positives.
 *
 * The brands half degrades badly on TikTok and is expected to: of the 454
 * sponsorship_detection rows this filter trusts, 27 carry a tiktok_handle. It
 * is kept because it is free and correct where it applies, not because it
 * contributes volume — brand_aliases is the load-bearing half on both
 * platforms.
 */
/**
 * Trusted-brand handles for this platform, from the `brands` table.
 *
 * Written as two literal queries rather than one parameterised by column name:
 * PostgREST's generated types resolve select strings at compile time, so a
 * computed column name loses all type checking on the result.
 */
async function loadTrustedBrandHandles(
  batch: string[],
  platform: 'instagram' | 'tiktok'
): Promise<string[]> {
  if (platform === 'tiktok') {
    const { data, error } = await supabase
      .from('brands')
      .select('tiktok_handle')
      .in('tiktok_handle', batch)
      .in('data_source', TRUSTED_BRAND_DATA_SOURCES);
    if (error) throw new Error(`brands lookup failed: ${error.message}`);
    return (data || []).map(row => norm(row.tiktok_handle));
  }

  const { data, error } = await supabase
    .from('brands')
    .select('instagram_handle')
    .in('instagram_handle', batch)
    .in('data_source', TRUSTED_BRAND_DATA_SOURCES);
  if (error) throw new Error(`brands lookup failed: ${error.message}`);
  return (data || []).map(row => norm(row.instagram_handle));
}

/**
 * Handles that are not importable creators, from either classification source.
 * Runs before the profile scrape so excluded handles cost nothing.
 */
export async function loadEntityExcludedHandles(
  handles: string[],
  platform: 'instagram' | 'tiktok'
): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (handles.length === 0) return excluded;

  for (const batch of chunk(handles, LOOKUP_CHUNK)) {
    const [aliasResult, brandHandles] = await Promise.all([
      supabase
        .from('brand_aliases')
        .select('alias, entity_type')
        .in('alias', batch)
        .in('entity_type', NON_CREATOR_ENTITY_TYPES),
      loadTrustedBrandHandles(batch, platform),
    ]);

    if (aliasResult.error) throw new Error(`brand_aliases lookup failed: ${aliasResult.error.message}`);

    for (const row of aliasResult.data || []) excluded.add(norm(row.alias));
    for (const handle of brandHandles) excluded.add(handle);
  }

  return excluded;
}
