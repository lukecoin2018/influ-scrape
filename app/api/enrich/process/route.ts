import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

// ── Helper functions ──────────────────────────────────────────────────────────

function extractHashtags(caption: string): string[] {
  const matches = caption.match(/#[\w\u00C0-\u024F]+/g) || [];
  return [...new Set(matches.map(h => h.slice(1).toLowerCase()))];
}

function extractMentions(caption: string): string[] {
  const matches = caption.match(/@[\w.]+/g) || [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

function detectSponsorship(caption: string, taggedAccounts: string[]): {
  isSponsored: boolean;
  signals: string[];
  brands: string[];
} {
  const signals: string[] = [];
  const captionLower = caption.toLowerCase();

  const sponsorHashtags = [
    '#ad', '#sponsored', '#gifted', '#paid', '#partner',
    '#brandpartner', '#brandambassador', '#collab',
    '#werbung', '#anzeige',
    '#pub', '#publicite',
  ];

  for (const tag of sponsorHashtags) {
    if (captionLower.includes(tag)) signals.push(tag);
  }

  if (captionLower.includes('paid partnership')) signals.push('paid_partnership_label');
  if (captionLower.includes('sponsored by')) signals.push('sponsored_by');
  if (captionLower.includes('gifted by')) signals.push('gifted_by');
  if (captionLower.includes('in collaboration with')) signals.push('collaboration');
  if (captionLower.includes('ad |') || captionLower.includes('| ad')) signals.push('ad_label');

  const brands = signals.length > 0 ? taggedAccounts : [];

  return {
    isSponsored: signals.length > 0,
    signals,
    brands,
  };
}

function mapInstagramPost(post: any, socialProfileId: string) {
  const caption = post.caption || '';
  const hashtags = extractHashtags(caption);
  const taggedAccounts = extractMentions(caption).concat(
    (post.taggedUsers || []).map((u: any) => u.username || u).filter(Boolean)
  );
  const { isSponsored, signals, brands } = detectSponsorship(caption, taggedAccounts);

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
    is_sponsored: isSponsored,
    sponsor_signals: signals,
    detected_brands: brands,
  };
}

function mapTikTokPost(post: any, socialProfileId: string) {
  const caption = post.text || post.desc || '';
  const hashtags = extractHashtags(caption).concat(
    (post.hashtags || []).map((h: any) => h.name || h).filter(Boolean)
  );
  const taggedAccounts = extractMentions(caption);
  const { isSponsored, signals, brands } = detectSponsorship(caption, taggedAccounts);

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
    is_sponsored: isSponsored,
    sponsor_signals: signals,
    detected_brands: brands,
  };
}

function calculateEnrichmentData(posts: any[], followerCount: number) {
  if (!posts.length) return null;

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

  const sponsoredPosts = posts.filter(p => p.is_sponsored);
  const allDetectedBrands = [...new Set(sponsoredPosts.flatMap(p => p.detected_brands || []))];

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
    sponsored_posts_count: sponsoredPosts.length,
    detected_brands: allDetectedBrands,
    brand_partnership_count: allDetectedBrands.length,
  };
}

async function pollRun(runId: string): Promise<any> {
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(
      `${APIFY_API_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
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

    // 3. Map posts
    const mappedPosts = rawPosts
      .slice(0, postsPerCreator)
      .map((post: any) =>
        platform === 'instagram'
          ? mapInstagramPost(post, socialProfileId)
          : mapTikTokPost(post, socialProfileId)
      )
      .filter((p: any) => p.post_id); // skip posts with no ID

    // 4. Save posts (upsert)
    for (const post of mappedPosts) {
      const { error } = await supabase
        .from('creator_posts')
        .upsert(post, { onConflict: 'social_profile_id,post_id' });
      if (error) console.error(`Failed to save post ${post.post_id}:`, error.message);
    }

    // 5. Calculate enrichment metrics
    const enrichmentData = calculateEnrichmentData(mappedPosts, followerCount);

    // 6. Update social_profiles
    const { error: updateError } = await supabase
      .from('social_profiles')
      .update({
        enrichment_data: enrichmentData,
        enriched_at: new Date().toISOString(),
        posts_scraped_count: mappedPosts.length,
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
