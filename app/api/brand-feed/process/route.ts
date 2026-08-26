import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  startPostScraper,
  startProfileScraper,
  waitForRun,
  getDatasetItems,
  mapProfileToCreator,
} from '@/lib/apify';
import {
  detectCollabsInBrandPost,
  summariseFieldCoverage,
  type BrandFeedPost,
  type BrandPostCollabs,
} from '@/lib/collabDetection';
import { saveDiscoveredCreators, type ImportableCreator } from '@/lib/creatorImport';
import {
  importStatusFor,
  normaliseRange,
  type FollowerRange,
} from '@/lib/followerRange';
import type { InstagramProfile } from '@/lib/types';

/**
 * Scrapes one brand's Instagram feed, discovers the creators it collaborates
 * with, and records brand↔creator partnership edges.
 *
 * Brand posts are deliberately NOT persisted. creator_posts.social_profile_id
 * is a FK to social_profiles, and brands have no row there — storing brand
 * posts would mean fabricating social_profiles rows for brands or adding a
 * parallel table. The posts are a means to the edges.
 *
 * Candidates pass through two filters:
 *
 *   1. Entity filter (free, runs BEFORE the profile scrape). Drops handles
 *      classified as non-creators. Saves the scrape cost entirely.
 *   2. Follower range (runs AFTER the scrape, since follower_count only
 *      arrives with the profile). Out-of-range creators are still imported
 *      and still get edges — they are just marked import_status
 *      'out_of_range_high' or 'out_of_range_low' so no spend pipeline picks
 *      them up. The direction is recorded because the two groups diverge:
 *      below-range creators can grow into range and be promoted, above-range
 *      ones are a separate mega-creator population.
 *
 * This route never touches brands' statistics columns
 * (total_partnerships_detected, avg/min/max_partner_follower_count,
 * preferred_creator_tier, active_niches) and never calls
 * recalculate_brand_stats(). That RPC rebuilds all of those from the
 * partnerships table, which the creator enrichment pipeline does not write —
 * running it here would replace enrich-built counters with a handful of
 * feed-derived numbers, and those columns feed brand-bracket matching in the
 * live platform app. The only brands column written here is feed_scraped_at.
 */

/**
 * brand_aliases classifications that are not importable creators.
 * 'creator' and 'unknown' proceed, as do handles with no alias row at all —
 * unknown is genuinely unclassified and excluding it would discard exactly
 * the new creators we are looking for.
 */
const NON_CREATOR_ENTITY_TYPES = ['brand', 'celebrity', 'media', 'venue', 'fragment'];

/**
 * Only brands rows with real scraped profile data are trusted as a
 * "this is a brand" signal.
 *
 * The other 11,402 rows come from data_source='enrich_pipeline', which files
 * a brands row for every handle any creator ever mentioned. 233 known
 * Instagram creators sit in that set, 220 of them inside a 30k-500k band —
 * excluding on the whole table would blacklist the creators we want.
 */
const TRUSTED_BRAND_DATA_SOURCES = ['sponsorship_detection'];

/** Out-of-range examples surfaced per brand, per direction. */
const SAMPLES_PER_DIRECTION = 12;

/** Guard against a single post tagging an implausible number of accounts. */
const MAX_NEW_CREATORS_PER_BRAND = 60;

/** PostgREST `in.()` lists go in the URL; keep them well short of URL limits. */
const LOOKUP_CHUNK = 100;

const norm = (value: unknown) =>
  String(value ?? '').trim().toLowerCase().replace(/^@/, '');

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Brand row resolution ──────────────────────────────────────────────────────

/**
 * Finds the brands row for this handle, creating a stub when the handle is a
 * classified alias with no brands row (444 such orphans today).
 * partnerships.brand_id is NOT NULL, so an edge cannot be recorded without one.
 *
 * The stub is created up front rather than lazily at edge-writing time so that
 * feed_scraped_at can be stamped even when a brand yields no collaborations —
 * otherwise zero-yield orphans would be re-scraped on every run forever.
 */
async function resolveOrCreateBrand(
  brandHandle: string,
  hintedBrandId?: string | null
): Promise<{ brandId: string; created: boolean }> {
  if (hintedBrandId) {
    const { data } = await supabase
      .from('brands')
      .select('id')
      .eq('id', hintedBrandId)
      .maybeSingle();
    if (data?.id) return { brandId: data.id, created: false };
  }

  const { data: existing } = await supabase
    .from('brands')
    .select('id')
    .eq('instagram_handle', brandHandle)
    .maybeSingle();

  if (existing?.id) return { brandId: existing.id, created: false };

  const { data: inserted, error } = await supabase
    .from('brands')
    .insert({
      instagram_handle: brandHandle,
      profile_url: `https://instagram.com/${brandHandle}`,
      data_source: 'brand_feed',
      status: 'detected',
    })
    .select('id')
    .single();

  if (inserted?.id) return { brandId: inserted.id, created: true };

  // Lost a race, or a unique constraint rejected the insert — re-read.
  const { data: raced } = await supabase
    .from('brands')
    .select('id')
    .eq('instagram_handle', brandHandle)
    .maybeSingle();

  if (raced?.id) return { brandId: raced.id, created: false };

  throw new Error(`Could not resolve or create brand row for ${brandHandle}: ${error?.message}`);
}

// ── Filter 1: entity classification (free, pre-scrape) ────────────────────────

/**
 * Handles that are not importable creators, from either classification source.
 * Runs before the profile scrape so excluded handles cost nothing.
 */
async function loadEntityExcludedHandles(handles: string[]): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (handles.length === 0) return excluded;

  for (const batch of chunk(handles, LOOKUP_CHUNK)) {
    const [aliasResult, brandResult] = await Promise.all([
      supabase
        .from('brand_aliases')
        .select('alias, entity_type')
        .in('alias', batch)
        .in('entity_type', NON_CREATOR_ENTITY_TYPES),
      supabase
        .from('brands')
        .select('instagram_handle, data_source')
        .in('instagram_handle', batch)
        .in('data_source', TRUSTED_BRAND_DATA_SOURCES),
    ]);

    if (aliasResult.error) throw new Error(`brand_aliases lookup failed: ${aliasResult.error.message}`);
    if (brandResult.error) throw new Error(`brands lookup failed: ${brandResult.error.message}`);

    for (const row of aliasResult.data || []) excluded.add(norm(row.alias));
    for (const row of brandResult.data || []) excluded.add(norm(row.instagram_handle));
  }

  return excluded;
}

/** handle -> creators.id, for handles that already have an Instagram profile. */
async function resolveCreatorIds(handles: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (handles.length === 0) return resolved;

  for (const batch of chunk(handles, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from('social_profiles')
      .select('handle, creator_id')
      .eq('platform', 'instagram')
      .in('handle', batch);

    if (error) throw new Error(`social_profiles lookup failed: ${error.message}`);
    for (const row of data || []) {
      if (row.creator_id) resolved.set(norm(row.handle), row.creator_id as string);
    }
  }

  return resolved;
}

// ── Filter 2: follower range (post-scrape) + import ───────────────────────────

interface ImportOutcome {
  attempted: number;
  saved: number;
  failed: number;
  inRange: number;
  outOfRangeHigh: number;
  outOfRangeLow: number;
  outOfRangeSamples: { handle: string; followerCount: number; status: string }[];
  errors: string[];
}

/**
 * Profile-scrapes newly discovered handles and pushes them through the shared
 * creator import path, so they land in creators/social_profiles exactly as
 * hashtag discovery and manual entry do.
 *
 * Both in-range and out-of-range creators are imported. The range only decides
 * import_status, which is what keeps out-of-range profiles out of the
 * enrichment, intelligence and embedding queues.
 */
async function importNewCreators(
  handles: string[],
  range: FollowerRange
): Promise<ImportOutcome> {
  const empty: ImportOutcome = {
    attempted: 0, saved: 0, failed: 0, inRange: 0, outOfRangeHigh: 0, outOfRangeLow: 0,
    outOfRangeSamples: [], errors: [],
  };
  if (handles.length === 0) return empty;

  const { runId } = await startProfileScraper(handles);
  const { datasetId } = await waitForRun(runId);

  if (!datasetId) throw new Error(`Profile scrape for ${handles.length} handles returned no dataset`);

  const profiles = await getDatasetItems<InstagramProfile>(datasetId);

  const creators: ImportableCreator[] = [];
  const outOfRangeSamples: { handle: string; followerCount: number; status: string }[] = [];
  let inRange = 0;
  let outOfRangeHigh = 0;
  let outOfRangeLow = 0;

  for (const profile of profiles) {
    const mapped = mapProfileToCreator(profile);
    const handle = norm(mapped.handle);
    if (!handle) continue;

    const importStatus = importStatusFor(mapped.followerCount, range);
    if (importStatus === 'out_of_range_high') outOfRangeHigh++;
    else if (importStatus === 'out_of_range_low') outOfRangeLow++;
    else inRange++;

    // Cap per direction, not overall: a shared cap would let a brand tagging
    // a dozen mega-accounts crowd the small ones out of the sample entirely,
    // and the below-min accounts are the ones worth eyeballing for promotion.
    if (importStatus !== 'active') {
      const sameDirection = outOfRangeSamples.filter(s => s.status === importStatus).length;
      if (sameDirection < SAMPLES_PER_DIRECTION) {
        outOfRangeSamples.push({
          handle, followerCount: mapped.followerCount, status: importStatus,
        });
      }
    }

    creators.push({
      handle,
      fullName: mapped.fullName,
      bio: (mapped.bio || '').slice(0, 500),
      followerCount: mapped.followerCount,
      followingCount: mapped.followingCount,
      postsCount: mapped.postsCount,
      engagementRate: mapped.engagementRate,
      isVerified: mapped.isVerified,
      isBusinessAccount: mapped.isBusinessAccount,
      categoryName: mapped.categoryName,
      profilePicUrl: mapped.profilePicUrl,
      profileUrl: mapped.profileUrl,
      website: mapped.website,
      discoveredViaHashtags: ['brand_feed'],
      importStatus,
    });
  }

  const result = await saveDiscoveredCreators(creators, 'instagram');

  return {
    attempted: handles.length,
    saved: result.saved,
    failed: result.failed,
    inRange,
    outOfRangeHigh,
    outOfRangeLow,
    outOfRangeSamples,
    errors: result.errors.slice(0, 5),
  };
}

// ── Edge writing ──────────────────────────────────────────────────────────────

/**
 * One edge per (post, creator). Membership in creatorIds is the only gate:
 * entity-excluded candidates that already have a creators row still get their
 * edges recorded — a Zara↔celebrity link is useful brand intelligence even
 * though that account is not an importable creator. Entity-excluded handles
 * with no creators row simply cannot have an edge, because
 * partnerships.creator_id is NOT NULL.
 */
function buildEdges(
  posts: BrandPostCollabs[],
  brandId: string,
  creatorIds: Map<string, string>
) {
  const seen = new Set<string>();
  const edges: Record<string, unknown>[] = [];

  for (const post of posts) {
    // No post_url means no identity to dedupe on — the unique index cannot
    // protect these rows, so they are skipped rather than duplicated later.
    if (!post.postUrl) continue;

    for (const candidate of post.candidates) {
      const creatorId = creatorIds.get(candidate.handle);
      if (!creatorId) continue;

      const key = `${creatorId}|${brandId}|${post.postUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        creator_id: creatorId,
        brand_id: brandId,
        post_url: post.postUrl,
        post_type: post.postType,
        post_caption: post.postCaption.slice(0, 2000),
        posted_at: post.postedAt,
        likes_count: post.likesCount,
        comments_count: post.commentsCount,
        views_count: post.viewsCount,
        detection_signals: candidate.signals,
        detection_confidence: candidate.confidence,
        // Not hashtag-discovered; the provenance lives in discovery_source.
        discovered_via_hashtag: null,
        discovery_source: 'brand_feed',
      });
    }
  }

  return edges;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const started = Date.now();

  try {
    const body = await request.json().catch(() => ({}));

    const brandHandle = norm(body.handle);
    const postsPerBrand = Math.max(1, Math.min(Number(body.postsPerBrand) || 12, 50));
    const dataDetailLevel: 'basicData' | 'detailedData' =
      body.dataDetailLevel === 'detailedData' ? 'detailedData' : 'basicData';
    const range = normaliseRange(body.minFollowers, body.maxFollowers);

    if (!brandHandle) {
      return NextResponse.json({ error: 'handle is required' }, { status: 400 });
    }

    // 1. Brand row (created here for orphan aliases).
    const { brandId, created: brandCreated } = await resolveOrCreateBrand(
      brandHandle,
      typeof body.brandId === 'string' ? body.brandId : null
    );

    // 2. Scrape the brand's own feed.
    const { runId } = await startPostScraper([brandHandle], postsPerBrand, dataDetailLevel);
    const { datasetId } = await waitForRun(runId);

    if (!datasetId) throw new Error(`Post scrape for ${brandHandle} returned no dataset`);

    const rawPosts = (await getDatasetItems<BrandFeedPost>(datasetId, postsPerBrand))
      .slice(0, postsPerBrand);

    // 3. Extract collaboration candidates.
    const perPost = rawPosts.map(post => detectCollabsInBrandPost(post, brandHandle));
    const fieldCoverage = summariseFieldCoverage(rawPosts);

    const candidateHandles = [
      ...new Set(perPost.flatMap(p => p.candidates.map(c => c.handle))),
    ];

    // 4. Entity filter — free, before any scraping.
    const entityExcluded = await loadEntityExcludedHandles(candidateHandles);
    const importable = candidateHandles.filter(h => !entityExcluded.has(h));

    // 5. Resolve creator ids for ALL candidates, excluded ones included: an
    // entity-excluded handle already in the database still earns its edges.
    const creatorIds = await resolveCreatorIds(candidateHandles);

    const knownImportable = importable.filter(h => creatorIds.has(h));
    const allNewHandles = importable.filter(h => !creatorIds.has(h));
    const newHandles = allNewHandles.slice(0, MAX_NEW_CREATORS_PER_BRAND);

    // 6. Scrape and import the new ones, flagging by follower range.
    const importResult = await importNewCreators(newHandles, range);

    if (importResult.saved > 0) {
      const refreshed = await resolveCreatorIds(newHandles);
      refreshed.forEach((creatorId, handle) => creatorIds.set(handle, creatorId));
    }

    // 7. Record the edges.
    const edges = buildEdges(perPost, brandId, creatorIds);

    // Which of those edges came from candidates the entity filter rejected —
    // i.e. brand intelligence captured without creating a creator record.
    const excludedCreatorIds = new Set(
      [...creatorIds.entries()]
        .filter(([handle]) => entityExcluded.has(handle))
        .map(([, creatorId]) => creatorId)
    );
    const edgesFromEntityExcluded = edges.filter(e =>
      excludedCreatorIds.has(e.creator_id as string)
    ).length;

    let edgesWritten = 0;
    if (edges.length > 0) {
      const { data, error } = await supabase
        .from('partnerships')
        .upsert(edges, {
          onConflict: 'creator_id,brand_id,post_url',
          ignoreDuplicates: true,
        })
        .select('id');

      if (error) throw new Error(`Failed to write partnership edges: ${error.message}`);
      edgesWritten = data?.length ?? 0;
    }

    // 8. Stamp the feed timestamp. This is the ONLY brands column written on
    // an existing row — statistics columns are left entirely alone.
    const { error: stampError } = await supabase
      .from('brands')
      .update({ feed_scraped_at: new Date().toISOString() })
      .eq('id', brandId);

    if (stampError) {
      console.error(`Failed to stamp feed_scraped_at for ${brandHandle}:`, stampError.message);
    }

    return NextResponse.json({
      handle: brandHandle,
      brandId,
      brandCreated,
      postsScraped: rawPosts.length,
      range,

      // Candidate funnel
      candidatesFound: candidateHandles.length,
      entityExcluded: entityExcluded.size,
      knownCreators: knownImportable.length,
      newHandles: allNewHandles.length,
      newHandlesSkipped: allNewHandles.length - newHandles.length,

      // Two distinct outcomes for new handles
      importedInRange: importResult.inRange,
      importedOutOfRangeHigh: importResult.outOfRangeHigh,
      importedOutOfRangeLow: importResult.outOfRangeLow,
      importedOutOfRange: importResult.outOfRangeHigh + importResult.outOfRangeLow,
      outOfRangeSamples: importResult.outOfRangeSamples,
      creatorsImported: importResult.saved,
      creatorsFailed: importResult.failed,
      importErrors: importResult.errors,

      edgesBuilt: edges.length,
      edgesWritten,
      edgesDuplicate: edges.length - edgesWritten,
      edgesFromEntityExcluded,

      fieldCoverage,
      durationMs: Date.now() - started,
    });
  } catch (error: any) {
    console.error('Brand feed process error:', error);
    return NextResponse.json(
      { error: error.message || 'Brand feed processing failed' },
      { status: 500 }
    );
  }
}
