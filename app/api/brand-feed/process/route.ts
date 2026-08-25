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
import type { InstagramProfile } from '@/lib/types';

/**
 * Scrapes one brand's Instagram feed, discovers the creators it collaborates
 * with, and records brand↔creator partnership edges.
 *
 * Brand posts are deliberately NOT persisted. creator_posts.social_profile_id
 * is a FK to social_profiles, and brands have no row there — storing brand
 * posts would mean fabricating social_profiles rows for brands or adding a
 * parallel table. Neither is worth it: the posts are a means to the edges.
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
 * Alias classifications that are not creators. Candidates carrying one of
 * these are dropped before we spend a profile scrape on them.
 * 'creator' and 'unknown' are kept — unknown is genuinely unclassified, and
 * excluding it would discard exactly the new creators we are looking for.
 */
const NON_CREATOR_ENTITY_TYPES = ['brand', 'venue', 'media'];

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

// ── Candidate filtering ───────────────────────────────────────────────────────

/** Handles classified in brand_aliases as something other than a creator. */
async function loadNonCreatorHandles(handles: string[]): Promise<Set<string>> {
  const excluded = new Set<string>();

  for (const batch of chunk(handles, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from('brand_aliases')
      .select('alias, entity_type')
      .in('alias', batch)
      .in('entity_type', NON_CREATOR_ENTITY_TYPES);

    if (error) throw new Error(`brand_aliases lookup failed: ${error.message}`);
    for (const row of data || []) excluded.add(norm(row.alias));
  }

  return excluded;
}

/** handle -> creators.id, for handles that already have an Instagram profile. */
async function resolveCreatorIds(handles: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

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

// ── Creator import ────────────────────────────────────────────────────────────

/**
 * Profile-scrapes newly discovered handles and pushes them through the shared
 * creator import path, so they land in creators/social_profiles exactly as
 * hashtag discovery and manual entry do — and are picked up by the enrichment
 * queue automatically (mode not_enriched selects enriched_at IS NULL).
 */
async function importNewCreators(handles: string[]): Promise<{
  attempted: number;
  saved: number;
  failed: number;
  errors: string[];
}> {
  if (handles.length === 0) {
    return { attempted: 0, saved: 0, failed: 0, errors: [] };
  }

  const { runId } = await startProfileScraper(handles);
  const { datasetId } = await waitForRun(runId);

  if (!datasetId) throw new Error(`Profile scrape for ${handles.length} handles returned no dataset`);

  const profiles = await getDatasetItems<InstagramProfile>(datasetId);

  const creators: ImportableCreator[] = profiles
    .map(profile => {
      const mapped = mapProfileToCreator(profile);
      return {
        handle: norm(mapped.handle),
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
      };
    })
    .filter(c => c.handle);

  const result = await saveDiscoveredCreators(creators, 'instagram');

  return {
    attempted: handles.length,
    saved: result.saved,
    failed: result.failed,
    errors: result.errors.slice(0, 5),
  };
}

// ── Edge writing ──────────────────────────────────────────────────────────────

function buildEdges(
  posts: BrandPostCollabs[],
  brandId: string,
  creatorIds: Map<string, string>,
  excluded: Set<string>
) {
  const seen = new Set<string>();
  const edges: Record<string, unknown>[] = [];

  for (const post of posts) {
    // No post_url means no identity to dedupe on — the unique index cannot
    // protect these rows, so they are skipped rather than duplicated later.
    if (!post.postUrl) continue;

    for (const candidate of post.candidates) {
      if (excluded.has(candidate.handle)) continue;

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

    // 4. Drop handles classified as brands/venues/media.
    const excluded = await loadNonCreatorHandles(candidateHandles);
    const creatorHandles = candidateHandles.filter(h => !excluded.has(h));

    // 5. Split into known and new.
    const creatorIds = await resolveCreatorIds(creatorHandles);
    const allNewHandles = creatorHandles.filter(h => !creatorIds.has(h));
    const newHandles = allNewHandles.slice(0, MAX_NEW_CREATORS_PER_BRAND);

    // 6. Import the new ones through the shared creator path.
    const importResult = await importNewCreators(newHandles);

    if (importResult.saved > 0) {
      const refreshed = await resolveCreatorIds(newHandles);
      refreshed.forEach((creatorId, handle) => creatorIds.set(handle, creatorId));
    }

    // 7. Record the edges.
    const edges = buildEdges(perPost, brandId, creatorIds, excluded);

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
      candidatesFound: candidateHandles.length,
      candidatesExcluded: candidateHandles.length - creatorHandles.length,
      knownCreators: creatorHandles.length - allNewHandles.length,
      newHandles: allNewHandles.length,
      newHandlesSkipped: allNewHandles.length - newHandles.length,
      creatorsImported: importResult.saved,
      creatorsFailed: importResult.failed,
      importErrors: importResult.errors,
      edgesBuilt: edges.length,
      edgesWritten,
      edgesDuplicate: edges.length - edgesWritten,
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
