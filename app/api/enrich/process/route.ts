import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { detectBrandsInPost } from '@/lib/brandDetection';
import { recalculateCumulativeBrandFields, type StoredPostForBrandAgg } from '@/lib/brandAggregation';
import { extractMentionsFromCaption, handlesFromActorList } from '@/lib/handles';

const RECENT_POSTS_WINDOW = 15;

const APIFY_API_BASE = 'https://api.apify.com/v2';
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

// ── Helper functions ──────────────────────────────────────────────────────────

function extractHashtags(caption: string): string[] {
  const matches = caption.match(/#[\w\u00C0-\u024F]+/g) || [];
  return [...new Set(matches.map(h => h.slice(1).toLowerCase()))];
}

/**
 * Caption mentions, restricted to legal username characters.
 *
 * The previous pattern (/@[\w.\u00C0-\u024F'-]+/) also matched accents,
 * apostrophes and hyphens, none of which any platform allows in a username.
 * It was lifting brand NAMES out of caption prose — "loréal", "lancôme",
 * "kiehl's", "coca-cola" — and filing them as brand accounts.
 */
const extractMentions = extractMentionsFromCaption;

function mapInstagramPost(post: any, socialProfileId: string) {
  const caption = post.caption || '';
  const hashtagsFromApify = Array.isArray(post.hashtags)
    ? post.hashtags.map((h: any) => (typeof h === 'string' ? h : h.name || '')).filter(Boolean).map((h: string) => h.toLowerCase().replace(/^#/, ''))
    : [];
  const hashtagsFromCaption = extractHashtags(caption);
  const hashtags = [...new Set([...hashtagsFromApify, ...hashtagsFromCaption])];

  // coauthorProducers is Instagram's explicit "Collab" feature: the partner
  // co-owns the post. It is the strongest partnership signal the actor returns
  // and was previously dropped on the floor here.
  //
  // It folds into tagged_accounts rather than getting its own column, for two
  // reasons: creator_posts has no spare column or JSONB to hold it (so a
  // dedicated field would need a migration), and lib/brandAggregation.ts
  // re-runs detectBrandsInPost() over stored posts using tagged_accounts
  // alone — anything kept outside that array would be invisible to the
  // re-detection path and the two would drift apart.
  //
  // Trade-off: coauthor and plain tag are indistinguishable once stored.
  const taggedFromApify = handlesFromActorList(post.taggedUsers);
  const coauthorsFromApify = handlesFromActorList(post.coauthorProducers);
  const mentionsFromCaption = extractMentions(caption);
  const taggedAccounts = [
    ...new Set([...taggedFromApify, ...coauthorsFromApify, ...mentionsFromCaption]),
  ];

  const ownerUsername = post.ownerUsername || post.owner?.username || '';
  const detection = detectBrandsInPost({
    ownerUsername,
    caption,
    hashtags,
    taggedAccounts,
    url: post.url || '',
    type: post.type || 'image',
  });

  const timestamp = post.timestamp || post.takenAtTimestamp;
  const postedAt = timestamp
    ? new Date(typeof timestamp === 'number' ? timestamp * 1000 : timestamp).toISOString()
    : null;

  return {
    social_profile_id: socialProfileId,
    platform: 'instagram',
    post_id: post.id || post.shortCode || post.url,
    post_url: post.url || (post.shortCode ? `https://instagram.com/p/${post.shortCode}` : ''),
    post_type: post.type || (post.videoUrl ? 'video' : post.childPosts ? 'carousel' : 'image'),
    caption: caption.slice(0, 2000),
    hashtags,
    tagged_accounts: taggedAccounts,
    likes_count: post.likesCount || post.likes || 0,
    comments_count: post.commentsCount || post.comments || 0,
    views_count: post.videoViewCount || post.videoPlayCount || 0,
    shares_count: 0,
    saves_count: 0,
    posted_at: postedAt,
    is_sponsored: detection.isSponsoredContent,
    sponsor_signals: detection.detectionSignals,
    detected_brands: detection.brandHandles,
  };
}

function mapTikTokPost(post: any, socialProfileId: string) {
  const caption = post.text || post.desc || '';
  const hashtagsFromApify = (post.hashtags || [])
    .map((h: any) => (typeof h === 'string' ? h : h.name || ''))
    .filter(Boolean)
    .map((h: string) => h.toLowerCase().replace(/^#/, ''));
  const hashtagsFromCaption = extractHashtags(caption);
  const hashtags = [...new Set([...hashtagsFromApify, ...hashtagsFromCaption])];

  // TikTok captions render mentions as @DisplayName, not @username — "@Miss
  // Circle" or "@L'Oréal" — so parsing the caption yields display text
  // truncated at the first illegal character ("miss", "l"). The actor resolves
  // the real usernames in detailedMentions/mentions; use those.
  //
  // The caption fallback fires only when the actor supplies NEITHER field,
  // which means an older actor build. An actor that returns an empty array is
  // reporting "no mentions", and must not be second-guessed by the regex that
  // caused the problem.
  const hasActorMentions =
    Array.isArray(post.detailedMentions) || Array.isArray(post.mentions);

  const taggedAccounts = hasActorMentions
    ? [...new Set([
        ...handlesFromActorList(post.detailedMentions),
        ...handlesFromActorList(post.mentions),
      ])]
    : extractMentions(caption);

  const ownerUsername = post.authorMeta?.name || post.author?.uniqueId || post.uniqueId || '';

  const detection = detectBrandsInPost({
    ownerUsername,
    caption,
    hashtags,
    taggedAccounts,
    url: post.webVideoUrl || post.url || '',
    type: 'video',
  });

  const postedAt = post.createTimeISO ||
    (post.createTime ? new Date(post.createTime * 1000).toISOString() : null);

  return {
    social_profile_id: socialProfileId,
    platform: 'tiktok',
    post_id: post.id || post.videoId || post.webVideoUrl,
    post_url: post.webVideoUrl || post.url || '',
    post_type: 'video',
    caption: caption.slice(0, 2000),
    hashtags,
    tagged_accounts: taggedAccounts,
    likes_count: post.diggCount || post.likes || 0,
    comments_count: post.commentCount || post.comments || 0,
    views_count: post.playCount || post.plays || post.views || 0,
    shares_count: post.shareCount || post.shares || 0,
    saves_count: post.collectCount || 0,
    posted_at: postedAt,
    is_sponsored: detection.isSponsoredContent,
    sponsor_signals: detection.detectionSignals,
    detected_brands: detection.brandHandles,
  };
}

// ── Brand upsert ──────────────────────────────────────────────────────────────

/**
 * Saves detected brand handles to the brands table.
 * Uses upsert on instagram_handle so re-enriching a creator won't
 * create duplicate brand records — it just increments the partnership count.
 *
 * No Apify profile lookup here — that would be too slow per creator.
 * Full brand profile enrichment (follower count, bio etc.) happens when
 * Sponsorship Discovery runs, or can be triggered separately.
 *
 * Platform-aware: a handle detected in a TikTok post is a TikTok handle, and
 * filing it as an Instagram one is what left 22% of verified brands pointing
 * at Instagram accounts that may not exist. instagram_handle still carries
 * the identity for every brand — it is the lookup key here and the join key
 * for brand_aliases — but tiktok_handle, profile_url and mention_platforms
 * now reflect where the brand was actually seen.
 */
async function saveBrandsToTable(
  brandHandles: string[],
  creatorFollowerCount: number,
  platform: string
): Promise<void> {
  if (brandHandles.length === 0) return;

  const isTikTok = platform === 'tiktok';
  const profileUrlFor = (handle: string) =>
    isTikTok ? `https://tiktok.com/@${handle}` : `https://instagram.com/${handle}`;

  for (const handle of brandHandles) {
    // Check if brand already exists
    const { data: existing } = await supabase
      .from('brands')
      .select('id, total_partnerships_detected, avg_partner_follower_count, min_partner_follower_count, max_partner_follower_count, tiktok_handle, mention_platforms')
      .eq('instagram_handle', handle)
      .single();

    if (existing) {
      // Brand exists — increment partnership count and update follower stats
      const currentTotal = existing.total_partnerships_detected || 0;
      const currentAvg = existing.avg_partner_follower_count || 0;
      const currentMin = existing.min_partner_follower_count || creatorFollowerCount;
      const currentMax = existing.max_partner_follower_count || creatorFollowerCount;

      const newTotal = currentTotal + 1;
      const newAvg = Math.round((currentAvg * currentTotal + creatorFollowerCount) / newTotal);

      // Appended, never overwritten: a brand seen on both platforms must end
      // up with both, whichever order the mentions arrive in.
      const seenPlatforms = [
        ...new Set([...(existing.mention_platforms || []), platform]),
      ].sort();

      await supabase
        .from('brands')
        .update({
          total_partnerships_detected: newTotal,
          avg_partner_follower_count: newAvg,
          min_partner_follower_count: Math.min(currentMin, creatorFollowerCount),
          max_partner_follower_count: Math.max(currentMax, creatorFollowerCount),
          mention_platforms: seenPlatforms,
          // Only ever set, never cleared — an Instagram-sourced mention must
          // not wipe a TikTok handle recorded earlier.
          ...(isTikTok && !existing.tiktok_handle ? { tiktok_handle: handle } : {}),
          last_updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      // New brand — create minimal record. Profile details (bio, follower count
      // etc.) will be filled in when Sponsorship Discovery scrapes this brand,
      // or when a dedicated brand enrichment pass runs.
      await supabase
        .from('brands')
        .insert({
          // Identity slug for every brand regardless of source platform.
          instagram_handle: handle,
          ...(isTikTok ? { tiktok_handle: handle } : {}),
          mention_platforms: [platform],
          profile_url: profileUrlFor(handle),
          total_partnerships_detected: 1,
          avg_partner_follower_count: creatorFollowerCount,
          min_partner_follower_count: creatorFollowerCount,
          max_partner_follower_count: creatorFollowerCount,
          data_source: 'enrich_pipeline',
          first_detected_at: new Date().toISOString(),
          last_updated_at: new Date().toISOString(),
          status: 'detected',
        });
    }
  }
}

// ── Enrichment metrics ────────────────────────────────────────────────────────

/**
 * Computes engagement/frequency/content-mix stats from a recent window of
 * posts (latest RECENT_POSTS_WINDOW by posted_at). Sponsorship/brand fields
 * are NOT computed here — those are cumulative across all stored posts and
 * are merged in separately by the caller.
 */
function calculateWindowMetrics(posts: any[], followerCount: number) {
  if (!posts.length) {
    return {
      calculated_engagement_rate: 0,
      avg_likes: 0,
      avg_comments: 0,
      avg_views: 0,
      posting_frequency_per_week: 0,
      last_post_date: null,
      days_since_last_post: null,
      content_mix: {},
      top_hashtags: [],
    };
  }

  const totalLikes = posts.reduce((s, p) => s + (p.likes_count || 0), 0);
  const totalComments = posts.reduce((s, p) => s + (p.comments_count || 0), 0);
  const avgLikes = Math.round(totalLikes / posts.length);
  const avgComments = Math.round(totalComments / posts.length);

  const videoPosts = posts.filter(p => p.views_count > 0);
  const totalViews = videoPosts.reduce((s, p) => s + (p.views_count || 0), 0);

  let calculatedEngagement = 0;
  if (followerCount > 0) {
    calculatedEngagement = parseFloat(
      (((totalLikes + totalComments) / posts.length / followerCount) * 100).toFixed(2)
    );
  }

  const sortedByDate = [...posts]
    .filter(p => p.posted_at)
    .sort((a, b) => new Date(b.posted_at).getTime() - new Date(a.posted_at).getTime());

  let postingFrequency = 0;
  if (sortedByDate.length >= 2) {
    const newest = new Date(sortedByDate[0].posted_at).getTime();
    const oldest = new Date(sortedByDate[sortedByDate.length - 1].posted_at).getTime();
    const daySpan = (newest - oldest) / (1000 * 60 * 60 * 24);
    postingFrequency = daySpan > 0
      ? parseFloat((posts.length / daySpan * 7).toFixed(1))
      : 0;
  }

  const lastPostDate = sortedByDate.length > 0 ? sortedByDate[0].posted_at : null;
  const daysSinceLastPost = lastPostDate
    ? Math.round((Date.now() - new Date(lastPostDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const typeCounts: Record<string, number> = {};
  posts.forEach(p => {
    const type = p.post_type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });
  const contentMix: Record<string, number> = {};
  Object.entries(typeCounts).forEach(([type, count]) => {
    contentMix[type] = Math.round((count / posts.length) * 100);
  });

  const hashtagCounts: Record<string, number> = {};
  posts.forEach(p => {
    (p.hashtags || []).forEach((h: string) => {
      hashtagCounts[h] = (hashtagCounts[h] || 0) + 1;
    });
  });
  const topHashtags = Object.entries(hashtagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag]) => tag);

  return {
    calculated_engagement_rate: calculatedEngagement,
    avg_likes: avgLikes,
    avg_comments: avgComments,
    avg_views: videoPosts.length > 0 ? Math.round(totalViews / videoPosts.length) : 0,
    posting_frequency_per_week: postingFrequency,
    last_post_date: lastPostDate,
    days_since_last_post: daysSinceLastPost,
    content_mix: contentMix,
    top_hashtags: topHashtags,
  };
}

async function pollRun(runId: string): Promise<any> {
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`${APIFY_API_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    const data = await res.json();
    const status = data.data?.status;
    if (status === 'SUCCEEDED') return data.data;
    if (status === 'FAILED' || status === 'ABORTED') {
      throw new Error(`Apify run ${runId} ${status}`);
    }
  }
}

async function fetchDataset(datasetId: string): Promise<any[]> {
  const res = await fetch(
    `${APIFY_API_BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`
  );
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const { handle, platform, postsPerCreator = 15 } = await request.json();

    if (!handle || !platform) {
      return NextResponse.json({ error: 'handle and platform are required' }, { status: 400 });
    }

    // 1. Look up social_profile
    const { data: profile, error: profileError } = await supabase
      .from('social_profiles')
      .select('id, follower_count')
      .eq('handle', handle)
      .eq('platform', platform)
      .single();

    if (profileError || !profile) {
      return NextResponse.json(
        { error: `No social_profile found for ${handle} on ${platform}` },
        { status: 404 }
      );
    }

    const socialProfileId = profile.id;
    const followerCount = profile.follower_count || 0;

    // 2. Start Apify post scraper
    let actorId: string;
    let input: any;

    if (platform === 'instagram') {
      actorId = 'apify~instagram-post-scraper';
      input = { username: [handle], resultsLimit: postsPerCreator };
    } else {
      actorId = 'clockworks~tiktok-profile-scraper';
      input = {
        profiles: [`https://www.tiktok.com/@${handle}`],
        resultsPerPage: postsPerCreator,
      };
    }

    const startRes = await fetch(
      `${APIFY_API_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );

    if (!startRes.ok) {
      const text = await startRes.text();
      throw new Error(`Failed to start scraper: ${startRes.status} ${text}`);
    }

    const startData = await startRes.json();
    const runId = startData.data.id;
    const runData = await pollRun(runId);
    const datasetId = runData.defaultDatasetId;
    const rawPosts = await fetchDataset(datasetId);

    console.log(`Raw posts for ${handle} (${platform}): ${rawPosts.length} items`);

    // 3. Map posts using shared detectBrandsInPost()
    const mappedPosts = rawPosts
      .slice(0, postsPerCreator)
      .map((post: any) =>
        platform === 'instagram'
          ? mapInstagramPost(post, socialProfileId)
          : mapTikTokPost(post, socialProfileId)
      )
      .filter((p: any) => p.post_id);

    // 4. Save posts (upsert)
    for (const post of mappedPosts) {
      const { error } = await supabase
        .from('creator_posts')
        .upsert(post, { onConflict: 'social_profile_id,post_id' });
      if (error) console.error(`Failed to save post ${post.post_id}:`, error.message);
    }

    // 4.5 Save detected brands to brands table
    // Collects all unique brand handles from sponsored posts and upserts them
    // into the brands table so they appear in the Brands database view.
    const allBrandHandles = [
      ...new Set(
        mappedPosts
          .filter(p => p.is_sponsored)
          .flatMap(p => p.detected_brands || [])
      )
    ];
    await saveBrandsToTable(allBrandHandles, followerCount, platform);
    console.log(`Saved ${allBrandHandles.length} brand handles for ${handle}`);

    // 5. Recalculate enrichment metrics from the database (not the scrape payload)
    // so stats reflect everything stored for this creator, not just this run.

    // 5a. Window stats (engagement, frequency, content mix, hashtags) come from
    // the latest RECENT_POSTS_WINDOW posts with a known posted_at. Posts with a
    // NULL posted_at are excluded — Postgres sorts NULLs first on DESC, which
    // would otherwise corrupt the "most recent" window.
    const { data: recentPosts, error: recentPostsError } = await supabase
      .from('creator_posts')
      .select('likes_count, comments_count, views_count, post_type, hashtags, posted_at')
      .eq('social_profile_id', socialProfileId)
      .not('posted_at', 'is', null)
      .order('posted_at', { ascending: false })
      .limit(RECENT_POSTS_WINDOW);

    if (recentPostsError) {
      console.error('Failed to load recent posts for metrics:', recentPostsError.message);
    }

    // 5b. Cumulative brand/sponsorship fields span ALL stored posts (including
    // ones with no posted_at) since partnership history never expires. Reuses
    // the same detection logic as /api/enrich/reprocess-brands so both paths
    // agree, and refreshes stale is_sponsored/detected_brands on older posts.
    const { data: allStoredPosts, error: allStoredPostsError } = await supabase
      .from('creator_posts')
      .select('id, caption, hashtags, tagged_accounts, is_sponsored, sponsor_signals, detected_brands, post_type')
      .eq('social_profile_id', socialProfileId);

    if (allStoredPostsError) {
      console.error('Failed to load stored posts for brand aggregation:', allStoredPostsError.message);
    }

    const cumulativeBrandFields = await recalculateCumulativeBrandFields(
      (allStoredPosts || []) as StoredPostForBrandAgg[],
      { persistPostUpdates: true }
    );

    // 5c. Total posts stored for this profile (not just what this run scraped).
    const { count: totalPostsCount, error: countError } = await supabase
      .from('creator_posts')
      .select('id', { count: 'exact', head: true })
      .eq('social_profile_id', socialProfileId);

    if (countError) {
      console.error('Failed to count stored posts:', countError.message);
    }

    const windowMetrics = calculateWindowMetrics(recentPosts || [], followerCount);
    const enrichmentData = (totalPostsCount ?? 0) > 0
      ? {
          ...windowMetrics,
          sponsored_posts_count: cumulativeBrandFields.sponsoredPostCount,
          detected_brands: cumulativeBrandFields.detectedBrands,
          brand_partnership_count: cumulativeBrandFields.brandPartnershipCount,
        }
      : null;

    // 6. Update social_profiles — enriched_at only advances on this successful pass.
    const { error: updateError } = await supabase
      .from('social_profiles')
      .update({
        enrichment_data: enrichmentData,
        enriched_at: new Date().toISOString(),
        posts_scraped_count: totalPostsCount ?? 0,
        engagement_rate: enrichmentData?.calculated_engagement_rate ?? null,
      })
      .eq('id', socialProfileId);

    if (updateError) {
      console.error('Failed to save enrichment data:', updateError.message);
    }

    return NextResponse.json({
      handle,
      platform,
      postsFound: rawPosts.length,
      postsSaved: mappedPosts.length,
      brandsFound: allBrandHandles.length,
      enrichmentData,
    });

  } catch (error: any) {
    console.error('Enrichment process error:', error);
    return NextResponse.json(
      { error: error.message || 'Enrichment failed' },
      { status: 500 }
    );
  }
}
