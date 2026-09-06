import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { parseEnumParam, parseBoundedInt, firstError } from '@/lib/requestParams';

/**
 * The seed queue: creators eligible to have their FOLLOWING list traversed.
 *
 * Read-only. Nothing here writes, and nothing here starts an Apify run — it
 * answers "which of the creators we already hold are worth expanding", and the
 * choosing is the operator's.
 *
 * ── THE SELECTION CRITERIA, AND WHY THEY ARE THESE ─────────────────────────
 *
 *   post_language IS NOT NULL   the mechanism is a LANGUAGE one
 *   following_count >= 150      what the seed CLAIMS it can return
 *   import_status = 'active'    in band, i.e. a creator we would want more of
 *   seed_expanded_at IS NULL    traversed once, never on a schedule
 *   seed_following_retrievable  IS DISTINCT FROM false — see below
 *   platform = 'tiktok'         the only platform with a following-list actor
 *
 * ── following_count IS A CLAIM, NOT A GUARANTEE ────────────────────────────
 *
 * @ramecabrera reads following_count 383 and privateAccount false, and its
 * following list cannot be fetched at all: TikTok's per-user connections
 * privacy setting hides it, and nothing on the profile says so. The traversal
 * SUCCEEDED with an empty dataset and cost $0.001.
 *
 * So the queue cannot tell "follows 383" from "follows 383 that you can see"
 * in advance, and no column it could read would tell it. What it CAN do is
 * remember: seed_following_retrievable is written false the first time a
 * traversal comes back empty against a non-zero following count, and this
 * query then stops offering that seed. IS DISTINCT FROM false, not = true, so
 * a seed never tried (NULL) is still offered — the default must be to try.
 *
 * PLACE IS DELIBERATELY NOT A CRITERION HERE, and that is a change from the
 * original design. Selecting seeds on place_city_code or place_country_code
 * assumes expansion concentrates by place, and it was measured and does not:
 * Bogota 42.3% against a 42% base, Colombia 46.2% against a 48.0% baseline
 * (z = -0.17). Filtering seeds on place would shrink the queue by an order of
 * magnitude in exchange for nothing. See docs/seed-expansion-investigation.md.
 *
 * This is NOT a statement that place columns are useless. place_city_code is
 * how the database knows which creators are in New York or Lambeth, and it
 * remains the right filter when a brief names a city. It is a filter on
 * creators already held; it is not an organising principle for finding more.
 *
 * ── THE BINDING CONSTRAINT IS post_language COVERAGE ───────────────────────
 *
 * Measured 2026-09-05: 3,712 active TikTok profiles, 2,362 of them following
 * 150+, and only 334 of those carry post_language — 76 Spanish, 235 English.
 * post_language comes from enrichment, which has run on a subset. The queue is
 * therefore bounded by enrichment coverage, not by the follower threshold, and
 * the response says so rather than presenting a short list as a full one.
 */

/** Below this, a seed cannot return enough to be worth an actor start. */
const MIN_FOLLOWING = 150;

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    // Honoured or rejected, never rewritten — lib/requestParams.
    const langP = parseEnumParam(
      'language',
      params.get('language'),
      ['es', 'en', 'pt', 'any'] as const,
      'any',
    );
    const limitP = parseBoundedInt('limit', params.get('limit'), { min: 1, max: 200, fallback: 50 });
    const minFollowingP = parseBoundedInt('minFollowing', params.get('minFollowing'),
      { min: 0, max: 100_000, fallback: MIN_FOLLOWING });

    const paramError = firstError(langP, limitP, minFollowingP);
    if (paramError) return NextResponse.json({ error: paramError }, { status: 400 });

    const language = (langP as { value: 'es' | 'en' | 'pt' | 'any' }).value;
    const limit = (limitP as { value: number }).value;
    const minFollowing = (minFollowingP as { value: number }).value;

    let query = supabase
      .from('social_profiles')
      // ONE string literal, not a concatenation: supabase-js infers the row
      // type from the literal, and `'a, b' + 'c'` collapses it to
      // GenericStringError on every field.
      .select('handle, follower_count, following_count, post_language, post_language_confidence, place_country_code, place_city_code, detected_country, bio, seed_last_attempt_at, seed_last_attempt_note', { count: 'exact' })
      .eq('platform', 'tiktok')
      .eq('import_status', 'active')
      .is('seed_expanded_at', null)
      // IS DISTINCT FROM false, spelled out. NOT .eq(true): NULL means never
      // attempted and must stay in the queue — the default is to try. Only a
      // confirmed-empty traversal excludes a seed.
      .or('seed_following_retrievable.is.null,seed_following_retrievable.is.true')
      .not('post_language', 'is', null)
      .gte('following_count', minFollowing)
      // Ordered, and by a column with no ties beyond duplicates: an unordered
      // PostgREST range skips and duplicates rows across pages. Descending
      // following_count also happens to put the seeds with the most to give
      // first, which is what the operator wants to pick from.
      .order('following_count', { ascending: false })
      .order('handle', { ascending: true })
      .limit(limit);

    if (language !== 'any') query = query.eq('post_language', language);

    const { data, error, count } = await query;
    if (error) throw new Error(`seed candidate lookup failed: ${error.message}`);

    const seeds = (data || []).map(row => ({
      handle: String(row.handle),
      followerCount: row.follower_count as number | null,
      // The ceiling on what this seed can return, whatever depth is requested.
      followingCount: row.following_count as number | null,
      postLanguage: row.post_language as string | null,
      postLanguageConfidence: row.post_language_confidence as number | null,
      // Carried for display only. Not a selection criterion — see the header.
      placeCountryCode: row.place_country_code as string | null,
      placeCityCode: row.place_city_code as string | null,
      detectedCountry: row.detected_country as string | null,
      bio: typeof row.bio === 'string' ? row.bio.slice(0, 120) : null,
      // Present when a previous attempt returned SOMETHING but less than
      // expected. A seed whose attempt returned nothing is excluded above, so
      // anything showing here is a partial, and worth seeing before re-picking.
      lastAttemptAt: row.seed_last_attempt_at as string | null,
      lastAttemptNote: row.seed_last_attempt_note as string | null,
    }));

    return NextResponse.json({
      seeds,
      /** Eligible seeds in total, not just the page returned. */
      totalEligible: count ?? seeds.length,
      language,
      minFollowing,
      limit,
      criteria: {
        platform: 'tiktok',
        importStatus: 'active',
        postLanguage: language === 'any' ? 'any non-null' : language,
        minFollowing,
        notYetExpanded: true,
        followingListRetrievable: 'null or true — a seed never tried is still offered',
        place: 'not a criterion — expansion does not concentrate by place',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load seed candidates';
    console.error('Seed candidate error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
