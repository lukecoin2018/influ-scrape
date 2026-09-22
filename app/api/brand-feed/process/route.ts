import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  startPostScraper,
  startTikTokPostScraper,
  waitForRun,
  getDatasetItems,
} from '@/lib/apify';
import {
  detectCollabsInBrandPost,
  detectCollabsInTikTokBrandPost,
  applyRepeatMentionConfidence,
  summariseFieldCoverage,
  summariseTikTokFieldCoverage,
  type BrandFeedPost,
  type TikTokBrandFeedPost,
  type BrandPostCollabs,
} from '@/lib/collabDetection';
import { loadEntityExcludedHandles } from '@/lib/entityFilter';
import {
  importScrapedProfiles,
  EMPTY_IMPORT_OUTCOME,
  type ImportOutcome,
} from '@/lib/profileImport';
import { normaliseRange } from '@/lib/followerRange';
import { isValidInstagramHandle, looseHandle as norm } from '@/lib/handles';
import { recomputeCastingProfile } from '@/lib/castingProfile';
import { BRAND_FEED_PLATFORMS, type BrandFeedPlatform } from '@/lib/brandFeedQueueCore';

/**
 * Scrapes one brand's own feed — Instagram or TikTok — discovers the creators
 * it collaborates with, and records brand↔creator partnership edges.
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
 * PLATFORM. `platform` in the body selects the actor, the detector, the
 * creator population the candidates resolve against, the entity-filter
 * column, the import actor, the platform written on every edge, and which
 * pair of brands stamp columns is written. Everything after the detector is
 * shared; the platform is threaded, not branched.
 *
 * This route never touches brands' statistics columns
 * (total_partnerships_detected, avg/min/max_partner_follower_count,
 * preferred_creator_tier, active_niches) and never calls
 * recalculate_brand_stats(). That RPC rebuilds all of those from the
 * partnerships table, which the creator enrichment pipeline does not write —
 * running it here would replace enrich-built counters with a handful of
 * feed-derived numbers, and those columns feed brand-bracket matching in the
 * live platform app. The brands columns written here are the platform's
 * feed-scrape stamp pair (feed_scraped_at + feed_post_count, or the tiktok_
 * pair) and, via recomputeCastingProfile, the casting_* columns.
 */

/** Guard against a single post tagging an implausible number of accounts. */
const MAX_NEW_CREATORS_PER_BRAND = 60;

/** PostgREST `in.()` lists go in the URL; keep them well short of URL limits. */
const LOOKUP_CHUNK = 100;

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
 * the feed stamp can be written even when a brand yields no collaborations —
 * otherwise zero-yield orphans would be re-scraped on every run forever.
 *
 * On TikTok the lookup tries tiktok_handle first and instagram_handle second.
 * Today the two columns are identical on every row that has both (the enrich
 * pipeline writes the same caption token into each), so the second lookup is
 * what finds a brand that was only ever seen on Instagram and is being tried
 * on TikTok by hand. brands.instagram_handle is NOT NULL and is the identity
 * key for the alias join, so a TikTok stub sets both columns to the same
 * value — the existing convention for the 3,875 rows flagged {tiktok} — and
 * records the platform it came from in mention_platforms.
 */
async function resolveOrCreateBrand(
  brandHandle: string,
  platform: BrandFeedPlatform,
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

  const lookup = async (column: 'instagram_handle' | 'tiktok_handle') => {
    // limit(1) rather than maybeSingle(): tiktok_handle has no unique
    // constraint, and a duplicate must not turn into a thrown error here.
    const { data } = await supabase
      .from('brands')
      .select('id')
      .eq(column, brandHandle)
      .order('id', { ascending: true })
      .limit(1);
    return data?.[0]?.id as string | undefined;
  };

  const existing = platform === 'tiktok'
    ? (await lookup('tiktok_handle')) ?? (await lookup('instagram_handle'))
    : await lookup('instagram_handle');

  if (existing) return { brandId: existing, created: false };

  const stub = platform === 'tiktok'
    ? {
        instagram_handle: brandHandle,
        tiktok_handle: brandHandle,
        mention_platforms: ['tiktok'],
        profile_url: `https://www.tiktok.com/@${brandHandle}`,
        data_source: 'brand_feed',
        status: 'detected',
      }
    : {
        instagram_handle: brandHandle,
        profile_url: `https://instagram.com/${brandHandle}`,
        data_source: 'brand_feed',
        status: 'detected',
      };

  const { data: inserted, error } = await supabase
    .from('brands')
    .insert(stub)
    .select('id')
    .single();

  if (inserted?.id) return { brandId: inserted.id, created: true };

  // Lost a race, or a unique constraint rejected the insert — re-read.
  const raced = await lookup('instagram_handle');
  if (raced) return { brandId: raced, created: false };

  throw new Error(`Could not resolve or create brand row for ${brandHandle}: ${error?.message}`);
}

interface ResolvedCreator {
  creatorId: string;
  /** Snapshotted onto the edge so the casting profile cannot drift. */
  followerCount: number | null;
}

/**
 * handle -> creator id and current follower count, for handles that already
 * have a profile ON THIS PLATFORM in ANY population.
 *
 * Reads v_social_profiles_all, not social_profiles. Out-of-range creators live
 * in social_profiles_archive; looking them up in social_profiles alone would
 * mean a re-scrape silently stopped re-recording their edges — losing exactly
 * the celebrity and mega-creator intelligence the archive exists to keep. 1,288
 * of 2,194 edges belong to archived creators.
 *
 * This is deliberately the opposite choice from the pipeline queues, which read
 * social_profiles directly because they must only ever see sellable creators.
 *
 * The follower count is read here rather than separately because it has to be
 * captured at edge-write time: partnerships.creator_follower_count records
 * what the creator was when the brand cast them, not what they are now.
 *
 * Platform-keyed, so a TikTok handle that happens to match an Instagram
 * creator's handle is NOT treated as known: the two are different profiles
 * (and, today, different creators rows — nothing links a person across
 * platforms).
 */
async function resolveCreators(
  handles: string[],
  platform: BrandFeedPlatform
): Promise<Map<string, ResolvedCreator>> {
  const resolved = new Map<string, ResolvedCreator>();
  if (handles.length === 0) return resolved;

  for (const batch of chunk(handles, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from('v_social_profiles_all')
      .select('handle, creator_id, follower_count')
      .eq('platform', platform)
      .in('handle', batch);

    if (error) throw new Error(`profile lookup failed: ${error.message}`);
    for (const row of data || []) {
      if (row.creator_id) {
        resolved.set(norm(row.handle), {
          creatorId: row.creator_id as string,
          followerCount: (row.follower_count as number | null) ?? null,
        });
      }
    }
  }

  return resolved;
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
  creators: Map<string, ResolvedCreator>,
  platform: BrandFeedPlatform
) {
  const seen = new Set<string>();
  const edges: Record<string, unknown>[] = [];

  for (const post of posts) {
    // No post_url means no identity to dedupe on — the unique index cannot
    // protect these rows, so they are skipped rather than duplicated later.
    if (!post.postUrl) continue;

    for (const candidate of post.candidates) {
      const creator = creators.get(candidate.handle);
      if (!creator) continue;
      const creatorId = creator.creatorId;

      const key = `${creatorId}|${brandId}|${post.postUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        creator_id: creatorId,
        brand_id: brandId,
        platform,
        post_url: post.postUrl,
        post_type: post.postType,
        post_caption: post.postCaption.slice(0, 2000),
        posted_at: post.postedAt,
        likes_count: post.likesCount,
        comments_count: post.commentsCount,
        views_count: post.viewsCount,
        detection_signals: candidate.signals,
        detection_confidence: candidate.confidence,
        // Captured now, not read back later: this is what the brand cast —
        // on this platform, which is what `platform` records.
        creator_follower_count: creator.followerCount,
        follower_count_source: 'snapshot',
        // Not hashtag-discovered; the provenance lives in discovery_source.
        discovered_via_hashtag: null,
        discovery_source: 'brand_feed',
      });
    }
  }

  return edges;
}

// ── Scraping ──────────────────────────────────────────────────────────────────

/**
 * The actor's own error item for a handle it cannot resolve. Shape known for
 * the Instagram profile scraper ({ error: 'not_found', ... }); for the TikTok
 * post scraper it is a guess that an error item, if any, carries a string
 * `error` the same way. An item with neither an id nor a URL is not a post
 * either way and is dropped before it can count as one.
 */
function isPostItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const o = item as Record<string, unknown>;
  if (typeof o.error === 'string') return false;
  return true;
}

async function scrapeFeed(
  brandHandle: string,
  platform: BrandFeedPlatform,
  postsPerBrand: number,
  dataDetailLevel: 'basicData' | 'detailedData'
): Promise<{
  perPost: BrandPostCollabs[];
  fieldCoverage: Record<string, number>;
  itemsReturned: number;
  postActor: string;
}> {
  if (platform === 'tiktok') {
    const { runId, actorId } = await startTikTokPostScraper(brandHandle, postsPerBrand);
    const { datasetId } = await waitForRun(runId);
    if (!datasetId) throw new Error(`TikTok post scrape for ${brandHandle} returned no dataset`);

    const items = await getDatasetItems<TikTokBrandFeedPost>(datasetId, postsPerBrand);
    const rawPosts = items.filter(isPostItem).slice(0, postsPerBrand);

    // Per-post detection, then the cross-post lift: a handle the brand
    // mentioned in two or more of these posts is high confidence.
    const perPost = applyRepeatMentionConfidence(
      rawPosts.map(post => detectCollabsInTikTokBrandPost(post, brandHandle))
    );
    return {
      perPost,
      fieldCoverage: summariseTikTokFieldCoverage(rawPosts),
      itemsReturned: items.length,
      postActor: actorId,
    };
  }

  const { runId } = await startPostScraper([brandHandle], postsPerBrand, dataDetailLevel);
  const { datasetId } = await waitForRun(runId);
  if (!datasetId) throw new Error(`Post scrape for ${brandHandle} returned no dataset`);

  const items = await getDatasetItems<BrandFeedPost>(datasetId, postsPerBrand);
  const rawPosts = items.filter(isPostItem).slice(0, postsPerBrand);
  const perPost = rawPosts.map(post => detectCollabsInBrandPost(post, brandHandle));
  return {
    perPost,
    fieldCoverage: summariseFieldCoverage(rawPosts),
    itemsReturned: items.length,
    postActor: 'apify~instagram-post-scraper',
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const started = Date.now();

  try {
    const body = await request.json().catch(() => ({}));

    const brandHandle = norm(body.handle);
    const platform: BrandFeedPlatform = BRAND_FEED_PLATFORMS.includes(body.platform)
      ? body.platform
      : 'instagram';
    const postsPerBrand = Math.max(1, Math.min(Number(body.postsPerBrand) || 12, 50));
    // Instagram-only actor input; ignored on TikTok, where the actor has no
    // equivalent and every field the detector reads is on the base item.
    const dataDetailLevel: 'basicData' | 'detailedData' =
      body.dataDetailLevel === 'detailedData' ? 'detailedData' : 'basicData';
    const range = normaliseRange(body.minFollowers, body.maxFollowers);

    if (!brandHandle) {
      return NextResponse.json({ error: 'handle is required' }, { status: 400 });
    }

    // Validated before anything is inserted. brands.instagram_handle is
    // varchar(64), so an unsplit handle list used to reach the INSERT and come
    // back as a Postgres "value too long" error attributed to the whole run
    // rather than to the one bad entry. The same rule serves both platforms:
    // TikTok usernames are the same character set with a shorter maximum
    // (lib/handles.ts), so anything a TikTok actor can resolve passes it.
    if (!isValidInstagramHandle(brandHandle)) {
      return NextResponse.json(
        { error: `Not a valid handle: "${brandHandle.slice(0, 80)}"` },
        { status: 400 }
      );
    }

    // 1. Brand row (created here for orphan aliases).
    const { brandId, created: brandCreated } = await resolveOrCreateBrand(
      brandHandle,
      platform,
      typeof body.brandId === 'string' ? body.brandId : null
    );

    // 2. Scrape the brand's own feed and 3. extract collaboration candidates.
    const { perPost, fieldCoverage, itemsReturned, postActor } = await scrapeFeed(
      brandHandle, platform, postsPerBrand, dataDetailLevel
    );
    const postsScraped = perPost.length;

    const candidateHandles = [
      ...new Set(perPost.flatMap(p => p.candidates.map(c => c.handle))),
    ];

    // 4. Entity filter — free, before any scraping.
    const entityExcluded = await loadEntityExcludedHandles(candidateHandles, platform);
    const importable = candidateHandles.filter(h => !entityExcluded.has(h));

    // 5. Resolve creator ids for ALL candidates, excluded ones included: an
    // entity-excluded handle already in the database still earns its edges.
    const creators = await resolveCreators(candidateHandles, platform);

    const knownImportable = importable.filter(h => creators.has(h));
    const allNewHandles = importable.filter(h => !creators.has(h));
    const newHandles = allNewHandles.slice(0, MAX_NEW_CREATORS_PER_BRAND);

    // 6. Cancellation point.
    //
    // A brand costs two Apify runs: the post scrape above, and the profile
    // scrape below. The post scrape is already paid for by the time we get
    // here, so its edges are still recorded — but if the client has gone
    // away (Stop aborts the fetch, which aborts request.signal) the profile
    // scrape has not started and is skipped. That is the billing this saves.
    //
    // Best-effort: request.signal fires on client disconnect, but a platform
    // that buffers the request may not surface it. Nothing breaks if it never
    // fires — the run simply completes as before.
    const abortedMidItem = request.signal?.aborted === true;

    const importResult: ImportOutcome = abortedMidItem
      ? { ...EMPTY_IMPORT_OUTCOME, errors: ['cancelled before profile scrape'] }
      : await importScrapedProfiles(newHandles, {
          range,
          platform,
          discoveredViaHashtags: ['brand_feed'],
        });

    if (importResult.saved > 0) {
      // Re-read after the import so newly created profiles bring their freshly
      // scraped follower count with them.
      const refreshed = await resolveCreators(newHandles, platform);
      refreshed.forEach((creator, handle) => creators.set(handle, creator));
    }

    // Handles the profile actor could not resolve: sent, batch returned, no
    // profile came back. On TikTok this is the "caption token is not the
    // account" signal for the creator side, and the first number to read.
    const notFound = importResult.scrapedHandles.filter(
      h => !importResult.measured.some(m => m.handle === h)
    );

    // 7. Record the edges.
    const edges = buildEdges(perPost, brandId, creators, platform);

    // Which of those edges came from candidates the entity filter rejected —
    // i.e. brand intelligence captured without creating a creator record.
    const excludedCreatorIds = new Set(
      [...creators.entries()]
        .filter(([handle]) => entityExcluded.has(handle))
        .map(([, creator]) => creator.creatorId)
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

    // 8. Stamp the platform's feed timestamp and post count. Statistics
    // columns are left entirely alone.
    //
    // Skipped when cancelled mid-item: this brand was only partly processed,
    // so leaving the stamp unset keeps it in the "never scraped" queue for a
    // later run. The edges written above are not lost — the unique index
    // makes re-recording them a no-op.
    if (!abortedMidItem) {
      // Advisory signal for spotting dormant/renamed handles. Written every
      // scrape so the latest reading always wins; nothing filters on it
      // unless the operator opts in.
      const stamp = platform === 'tiktok'
        ? { tiktok_feed_scraped_at: new Date().toISOString(), tiktok_feed_post_count: postsScraped }
        : { feed_scraped_at: new Date().toISOString(), feed_post_count: postsScraped };

      const { error: stampError } = await supabase
        .from('brands')
        .update(stamp)
        .eq('id', brandId);

      if (stampError) {
        console.error(`Failed to stamp ${platform} feed for ${brandHandle}:`, stampError.message);
      }
    }

    // 9. Refresh this brand's casting profile from its Instagram edges.
    // Writes only casting_* columns; never calls recalculate_brand_stats().
    // On a TikTok run this recomputes from the Instagram edges only
    // (lib/castingProfile.ts), so the stored profile does not move.
    let casting = null;
    try {
      casting = await recomputeCastingProfile(brandId, { range });
    } catch (err: any) {
      console.error(`Failed to recompute casting profile for ${brandHandle}:`, err.message);
    }

    return NextResponse.json({
      handle: brandHandle,
      platform,
      postActor,
      brandId,
      brandCreated,
      cancelledMidItem: abortedMidItem,
      postsScraped,
      itemsReturned,
      range,

      // Candidate funnel
      candidatesFound: candidateHandles.length,
      entityExcluded: entityExcluded.size,
      knownCreators: knownImportable.length,
      newHandles: allNewHandles.length,
      newHandlesSkipped: allNewHandles.length - newHandles.length,
      notFound: notFound.length,
      notFoundHandles: notFound.slice(0, 20),

      // Two distinct outcomes for new handles
      importedInRange: importResult.inRange,
      importedOutOfRangeHigh: importResult.outOfRangeHigh,
      importedOutOfRangeLow: importResult.outOfRangeLow,
      importedOutOfRange: importResult.outOfRangeHigh + importResult.outOfRangeLow,
      importedUnknownSize: importResult.unknownSize,
      outOfRangeSamples: importResult.outOfRangeSamples,
      unknownSizeSamples: importResult.unknownSizeSamples,
      creatorsImported: importResult.saved,
      creatorsFailed: importResult.failed,
      importErrors: importResult.errors,

      edgesBuilt: edges.length,
      edgesWritten,
      edgesDuplicate: edges.length - edgesWritten,
      edgesFromEntityExcluded,

      casting,
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
