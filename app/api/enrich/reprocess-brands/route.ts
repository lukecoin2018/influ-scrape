/**
 * POST /api/enrich/reprocess-brands
 *
 * Re-runs brand detection on already-stored creator_posts rows using the
 * improved isLikelyBrand filter. No Apify calls — zero scraping cost.
 *
 * Body params:
 *   handles?   string[]  — if provided, only reprocess these creator handles
 *                          if omitted, reprocesses ALL creators with stored posts
 *   dryRun?    boolean   — if true, returns what would change but writes nothing
 *
 * Returns per-creator before/after comparison so you can verify quality
 * before committing to a full re-run.
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { isLikelyBrand } from '@/lib/brandDetection';

// ── Types ──────────────────────────────────────────────────────────────────────

interface StoredPost {
  id: string;
  social_profile_id: string;
  caption: string | null;
  hashtags: string[] | null;
  tagged_accounts: string[] | null;
  is_sponsored: boolean;
  sponsor_signals: string[] | null;
  detected_brands: string[] | null;
  likes_count: number;
  comments_count: number;
  views_count: number;
  post_type: string;
  posted_at: string | null;
}

interface CreatorResult {
  handle: string;
  socialProfileId: string;
  before: string[];
  after: string[];
  removed: string[];
  kept: string[];
  sponsoredPostCount: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Re-run brand detection on a single stored post using the improved filter.
 * This mirrors the logic in detectBrandsInPost() but works from stored DB fields
 * (caption, hashtags, tagged_accounts) rather than raw Apify data.
 */
function redetectBrandsFromStoredPost(post: StoredPost): string[] {
  if (!post.is_sponsored) return [];

  const brands = new Set<string>();
  const caption = post.caption || '';

  // @mentions from stored caption
  const mentionRegex = /@([a-zA-Z0-9._]+)/g;
  let match;
  while ((match = mentionRegex.exec(caption)) !== null) {
    const handle = match[1].toLowerCase();
    if (isLikelyBrand(handle)) {
      brands.add(handle);
    }
  }

  // tagged_accounts stored from Apify taggedUsers
  const taggedAccounts = Array.isArray(post.tagged_accounts) ? post.tagged_accounts : [];
  taggedAccounts.forEach(handle => {
    if (typeof handle === 'string') {
      const clean = handle.toLowerCase().replace('@', '');
      if (isLikelyBrand(clean)) {
        brands.add(clean);
      }
    }
  });

  return Array.from(brands);
}

/**
 * Recalculate enrichment_data.detected_brands from a set of reprocessed posts.
 * Only touches the brand-related fields — other metrics (engagement, hashtags etc.)
 * are left exactly as they are.
 */
function recalculateBrandFields(posts: StoredPost[]): {
  detected_brands: string[];
  sponsored_posts_count: number;
  brand_partnership_count: number;
} {
  const sponsoredPosts = posts.filter(p => p.is_sponsored);
  const allBrands = new Set(sponsoredPosts.flatMap(p => redetectBrandsFromStoredPost(p)));

  return {
    detected_brands: Array.from(allBrands),
    sponsored_posts_count: sponsoredPosts.length,
    brand_partnership_count: allBrands.size,
  };
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

    const { data: profiles, error: profilesError } = await profileQuery;

    if (profilesError) {
      return NextResponse.json({ error: profilesError.message }, { status: 500 });
    }

    if (!profiles || profiles.length === 0) {
      return NextResponse.json({ error: 'No profiles found' }, { status: 404 });
    }

    const results: CreatorResult[] = [];
    let updatedCount = 0;
    let skippedCount = 0;

    // 2. For each profile, load stored posts and re-detect
    for (const profile of profiles) {
      const { data: rawPosts, error: postsError } = await supabase
        .from('creator_posts')
        .select(
          'id, social_profile_id, caption, hashtags, tagged_accounts, ' +
          'is_sponsored, sponsor_signals, detected_brands, ' +
          'likes_count, comments_count, views_count, post_type, posted_at'
        )
        .eq('social_profile_id', profile.id);

      const posts = rawPosts as StoredPost[] | null;

      if (postsError || !posts || posts.length === 0) {
        skippedCount++;
        continue;
      }

      // What was stored before
      const existingBrands: string[] =
        profile.enrichment_data?.detected_brands || [];

      // What the improved filter produces
      const newBrandFields = recalculateBrandFields(posts);
      const newBrands = newBrandFields.detected_brands;

      const removed = existingBrands.filter(b => !newBrands.includes(b));
      const kept = existingBrands.filter(b => newBrands.includes(b));

      results.push({
        handle: profile.handle,
        socialProfileId: profile.id,
        before: existingBrands,
        after: newBrands,
        removed,
        kept,
        sponsoredPostCount: newBrandFields.sponsored_posts_count,
      });

      // 3. Write back unless dry run
      if (!dryRun) {
        const updatedEnrichmentData = {
          ...(profile.enrichment_data || {}),
          detected_brands: newBrandFields.detected_brands,
          sponsored_posts_count: newBrandFields.sponsored_posts_count,
          brand_partnership_count: newBrandFields.brand_partnership_count,
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

    // 4. Summary stats
    const totalBrandsBefore = results.reduce((s, r) => s + r.before.length, 0);
    const totalBrandsAfter = results.reduce((s, r) => s + r.after.length, 0);
    const totalRemoved = results.reduce((s, r) => s + r.removed.length, 0);

    return NextResponse.json({
      dryRun,
      profilesProcessed: results.length,
      profilesSkipped: skippedCount,
      profilesUpdated: dryRun ? 0 : updatedCount,
      summary: {
        totalBrandsBefore,
        totalBrandsAfter,
        totalRemoved,
        reductionPercent:
          totalBrandsBefore > 0
            ? Math.round((totalRemoved / totalBrandsBefore) * 100)
            : 0,
      },
      // Per-creator detail — useful for spot-checking results
      results: results.map(r => ({
        handle: r.handle,
        sponsoredPostCount: r.sponsoredPostCount,
        before: r.before,
        after: r.after,
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
