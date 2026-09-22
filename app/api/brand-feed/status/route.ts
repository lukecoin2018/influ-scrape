import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  loadBrandFeedSources,
  poolForScope,
  BRAND_FEED_PLATFORMS,
  type BrandFeedScope,
} from '@/lib/brandFeedQueue';

const SCOPES: BrandFeedScope[] = ['verified_brands', 'classified_brands', 'all_brands'];

/**
 * Per-scope, per-platform queue sizing for the Brand Feed page. Recomputed
 * live from brand_aliases so newly classified brands show up without a
 * deploy.
 */
export async function GET() {
  try {
    // Preflight: every column below lives in a migration applied by hand
    // against Supabase. Without them every query fails with an opaque 400, so
    // detect it here and let the page say what's actually wrong — and which
    // file to run.
    const [
      { error: brandsColError },
      { error: partnershipsColError },
      { error: tiktokBrandsColError },
      { error: tiktokPartnershipsColError },
    ] = await Promise.all([
      supabase.from('brands').select('feed_scraped_at').limit(1),
      supabase.from('partnerships').select('discovery_source').limit(1),
      supabase.from('brands').select('tiktok_feed_scraped_at').limit(1),
      supabase.from('partnerships').select('platform').limit(1),
    ]);

    if (brandsColError || partnershipsColError) {
      return NextResponse.json({
        migrationsApplied: false,
        error:
          'Brand-feed migrations have not been applied yet. Run the files in ' +
          'supabase/migrations/ against this project, then reload.',
        detail: (brandsColError || partnershipsColError)?.message,
      });
    }

    if (tiktokBrandsColError || tiktokPartnershipsColError) {
      // The queue read selects the TikTok columns unconditionally, so the
      // Instagram side is down too until these are applied.
      return NextResponse.json({
        migrationsApplied: false,
        error:
          'The TikTok brand-feed migrations have not been applied yet. Run ' +
          'docs/migrations/2026-09-22-partnerships-platform.sql and ' +
          'docs/migrations/2026-09-22-brands-tiktok-feed.sql in the Supabase SQL ' +
          'editor, check each .verify.sql, then reload.',
        detail: (tiktokBrandsColError || tiktokPartnershipsColError)?.message,
      });
    }

    // One read of brand_aliases + brands, reused for every scope on both
    // platforms.
    const sources = await loadBrandFeedSources();

    const scopesFor = (platform: 'instagram' | 'tiktok') => Object.fromEntries(
      SCOPES.map(scope => {
        const pool = poolForScope(sources, scope, platform);
        return [scope, {
          total: pool.length,
          neverScraped: pool.filter(c => c.feedScrapedAt === null).length,
          scraped: pool.filter(c => c.feedScrapedAt !== null).length,
          orphans: pool.filter(c => c.brandId === null).length,
        }];
      })
    );

    const edgeCounts = await Promise.all(
      BRAND_FEED_PLATFORMS.map(platform =>
        supabase
          .from('partnerships')
          .select('id', { count: 'exact', head: true })
          .eq('discovery_source', 'brand_feed')
          .eq('platform', platform)
          .then(({ count }) => [platform, count ?? 0] as const)
      )
    );
    const brandFeedEdgesByPlatform = Object.fromEntries(edgeCounts);

    return NextResponse.json({
      migrationsApplied: true,
      // Instagram, under the names the page has always read.
      scopes: scopesFor('instagram'),
      brandFeedEdges: brandFeedEdgesByPlatform.instagram,
      // Both platforms, keyed.
      scopesByPlatform: {
        instagram: scopesFor('instagram'),
        tiktok: scopesFor('tiktok'),
      },
      brandFeedEdgesByPlatform,
    });
  } catch (error: any) {
    console.error('Brand feed status error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to load brand feed status' },
      { status: 500 }
    );
  }
}
