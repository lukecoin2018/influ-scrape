import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { loadBrandFeedSources, poolForScope, type BrandFeedScope } from '@/lib/brandFeedQueue';

const SCOPES: BrandFeedScope[] = ['verified_brands', 'classified_brands', 'all_brands'];

/**
 * Per-scope queue sizing for the Brand Feed page. Recomputed live from
 * brand_aliases so newly classified brands show up without a deploy.
 */
export async function GET() {
  try {
    // Preflight: both new columns live in migrations that are applied by hand
    // against Supabase. Without them every query below fails with an opaque
    // 400, so detect it here and let the page say what's actually wrong.
    const [{ error: brandsColError }, { error: partnershipsColError }] = await Promise.all([
      supabase.from('brands').select('feed_scraped_at').limit(1),
      supabase.from('partnerships').select('discovery_source').limit(1),
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

    // One read of brand_aliases + brands, reused for all three scopes.
    const sources = await loadBrandFeedSources();

    const scopes = Object.fromEntries(
      SCOPES.map(scope => {
        const pool = poolForScope(sources, scope);
        return [scope, {
          total: pool.length,
          neverScraped: pool.filter(c => c.feedScrapedAt === null).length,
          scraped: pool.filter(c => c.feedScrapedAt !== null).length,
          orphans: pool.filter(c => c.brandId === null).length,
        }];
      })
    );

    const { count: edgeCount } = await supabase
      .from('partnerships')
      .select('id', { count: 'exact', head: true })
      .eq('discovery_source', 'brand_feed');

    return NextResponse.json({
      migrationsApplied: true,
      scopes,
      brandFeedEdges: edgeCount ?? 0,
    });
  } catch (error: any) {
    console.error('Brand feed status error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to load brand feed status' },
      { status: 500 }
    );
  }
}
