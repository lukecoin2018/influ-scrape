import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  buildBrandFeedQueue,
  type BrandFeedScope,
  type BrandFeedOrder,
  type BrandFeedCandidate,
} from '@/lib/brandFeedQueue';

const SCOPES: BrandFeedScope[] = ['verified_brands', 'classified_brands', 'all_brands'];
const ORDERS: BrandFeedOrder[] = ['never_scraped', 'stale_first', 'top_creators'];

/**
 * Builds the brand-feed work queue. Read-only — no rows are created here,
 * including for orphan aliases; the process route handles that when it
 * actually runs a brand.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const scope: BrandFeedScope = SCOPES.includes(body.scope) ? body.scope : 'verified_brands';
    const order: BrandFeedOrder = ORDERS.includes(body.order) ? body.order : 'never_scraped';
    const batchSize = Math.max(1, Math.min(Number(body.batchSize) || 25, 2000));
    const explicitHandles: string[] = Array.isArray(body.handles) ? body.handles : [];

    // Explicit handles bypass scope and ordering entirely.
    if (explicitHandles.length > 0) {
      const handles = [...new Set(
        explicitHandles
          .map(h => String(h).trim().toLowerCase().replace(/^@/, ''))
          .filter(Boolean)
      )];

      const { data: brands } = await supabase
        .from('brands')
        .select('id, instagram_handle, feed_scraped_at, total_partnerships_detected')
        .in('instagram_handle', handles);

      const byHandle = new Map(
        (brands || []).map(b => [String(b.instagram_handle || '').toLowerCase(), b])
      );

      const items: BrandFeedCandidate[] = handles.map(handle => {
        const brand = byHandle.get(handle);
        return {
          handle,
          brandId: brand?.id ?? null,
          feedScrapedAt: brand?.feed_scraped_at ?? null,
          creatorsCount: null,
          aliasVerified: false,
          isClassifiedBrand: false,
          totalPartnershipsDetected: brand?.total_partnerships_detected ?? 0,
        };
      });

      return NextResponse.json({
        scope: 'specific',
        order: 'specific',
        items,
        handles: items.map(i => i.handle),
        count: items.length,
        poolSize: items.length,
        neverScrapedInQueue: items.filter(i => i.feedScrapedAt === null).length,
        rescrapesInQueue: items.filter(i => i.feedScrapedAt !== null).length,
        orphansInQueue: items.filter(i => i.brandId === null).length,
      });
    }

    const queue = await buildBrandFeedQueue(scope, order, batchSize);

    return NextResponse.json({
      scope,
      order,
      items: queue.items,
      handles: queue.items.map(i => i.handle),
      count: queue.items.length,
      poolSize: queue.poolSize,
      neverScrapedInQueue: queue.neverScrapedInQueue,
      rescrapesInQueue: queue.rescrapesInQueue,
      orphansInQueue: queue.orphansInQueue,
    });
  } catch (error: any) {
    console.error('Brand feed start error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to build brand feed queue' },
      { status: 500 }
    );
  }
}
