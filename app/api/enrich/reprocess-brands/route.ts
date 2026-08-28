import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { recalculateCumulativeBrandFields, type StoredPostForBrandAgg } from '@/lib/brandAggregation';
import { fetchAllRows } from '@/lib/supabasePaging';

// ── Types ──────────────────────────────────────────────────────────────────────

interface StoredPost extends StoredPostForBrandAgg {
  social_profile_id: string;
  likes_count: number;
  comments_count: number;
  views_count: number;
  posted_at: string | null;
}

interface CreatorResult {
  handle: string;
  socialProfileId: string;
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
  kept: string[];
  sponsoredPostCount: number;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const handles: string[] | undefined = body.handles;
    const dryRun: boolean = body.dryRun === true;

    // 1. Find social_profiles to process
    let profileQuery = supabase
      .from('social_profiles')
      .select('id, handle, enrichment_data');

    if (handles && handles.length > 0) {
      profileQuery = profileQuery.in('handle', handles);
    }

    // With no handles filter this walks every profile, so it is paged rather
    // than capped — a truncated read would silently reprocess only part of
    // the database and report success.
    let profiles: { id: string; handle: string; enrichment_data: any }[];
    try {
      profiles = handles && handles.length > 0
        ? ((await profileQuery).data || [])
        : await fetchAllRows(() => supabase
            .from('social_profiles')
            .select('id, handle, enrichment_data')
            .order('id', { ascending: true }));
    } catch (err: any) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }

    if (!profiles || profiles.length === 0) {
      return NextResponse.json({ error: 'No profiles found' }, { status: 404 });
    }

    const results: CreatorResult[] = [];
    let updatedCount = 0;
    let skippedCount = 0;

    // 2. For each profile, load posts and re-detect using shared lib
    for (const profile of profiles) {
      const { data: rawPosts, error: postsError } = await supabase
        .from('creator_posts')
        .select(
          'id, social_profile_id, platform, caption, hashtags, tagged_accounts, ' +
          'is_sponsored, sponsor_signals, detected_brands, ' +
          'likes_count, comments_count, views_count, post_type, posted_at'
        )
        .eq('social_profile_id', profile.id);

      const posts = rawPosts as StoredPost[] | null;

      if (postsError || !posts || posts.length === 0) {
        skippedCount++;
        continue;
      }

      const existingBrands: string[] = profile.enrichment_data?.detected_brands || [];

      // Re-detect using detectBrandsInPost() and update post-level fields
      const newBrandFields = await recalculateCumulativeBrandFields(posts, { persistPostUpdates: !dryRun });
      const newBrands = newBrandFields.detectedBrands;

      const added = newBrands.filter(b => !existingBrands.includes(b));
      const removed = existingBrands.filter(b => !newBrands.includes(b));
      const kept = existingBrands.filter(b => newBrands.includes(b));

      results.push({
        handle: profile.handle,
        socialProfileId: profile.id,
        before: existingBrands,
        after: newBrands,
        added,
        removed,
        kept,
        sponsoredPostCount: newBrandFields.sponsoredPostCount,
      });

      // Update enrichment_data on social_profiles
      if (!dryRun) {
        const updatedEnrichmentData = {
          ...(profile.enrichment_data || {}),
          detected_brands: newBrands,
          sponsored_posts_count: newBrandFields.sponsoredPostCount,
          brand_partnership_count: newBrandFields.brandPartnershipCount,
        };

        const { error: updateError } = await supabase
          .from('social_profiles')
          .update({ enrichment_data: updatedEnrichmentData })
          .eq('id', profile.id);

        if (updateError) {
          console.error(`Failed to update ${profile.handle}:`, updateError.message);
        } else {
          updatedCount++;
        }
      }
    }

    // 3. Summary
    const totalBrandsBefore = results.reduce((s, r) => s + r.before.length, 0);
    const totalBrandsAfter = results.reduce((s, r) => s + r.after.length, 0);
    const totalAdded = results.reduce((s, r) => s + r.added.length, 0);
    const totalRemoved = results.reduce((s, r) => s + r.removed.length, 0);

    return NextResponse.json({
      dryRun,
      profilesProcessed: results.length,
      profilesSkipped: skippedCount,
      profilesUpdated: dryRun ? 0 : updatedCount,
      summary: {
        totalBrandsBefore,
        totalBrandsAfter,
        totalAdded,
        totalRemoved,
        changePercent: totalBrandsBefore > 0
          ? Math.round(((totalBrandsAfter - totalBrandsBefore) / totalBrandsBefore) * 100)
          : 0,
      },
      results: results.map(r => ({
        handle: r.handle,
        sponsoredPostCount: r.sponsoredPostCount,
        before: r.before,
        after: r.after,
        added: r.added,
        removed: r.removed,
        kept: r.kept,
      })),
    });

  } catch (error: any) {
    console.error('Reprocess brands error:', error);
    return NextResponse.json(
      { error: error.message || 'Reprocess failed' },
      { status: 500 }
    );
  }
}
