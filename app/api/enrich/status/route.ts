import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const staleDays = Math.max(1, parseInt(searchParams.get('staleDays') || '90', 10) || 90);

    // Counted server-side rather than by fetching rows.
    //
    // This previously selected every active social_profile just to tally
    // eight numbers. PostgREST caps a plain select at 50,000 rows and gives
    // no indication when it truncates, so the tally would have started
    // silently under-reporting once the table passed that — a wrong number
    // with no error. head:true transfers no rows and has no cap.
    const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

    const countOf = async (filters: (q: any) => any) => {
      const { count, error } = await filters(
        supabase.from('social_profiles').select('*', { count: 'exact', head: true })
      );
      if (error) throw error;
      return count ?? 0;
    };

    const stats = {
      instagram: { total: 0, enriched: 0, pending: 0, stale: 0 },
      tiktok: { total: 0, enriched: 0, pending: 0, stale: 0 },
    };

    for (const platform of ['instagram', 'tiktok'] as const) {
      const base = (q: any) => q.eq('import_status', 'active').eq('platform', platform);

      const [total, enriched, stale] = await Promise.all([
        countOf(base),
        countOf(q => base(q).not('enriched_at', 'is', null)),
        countOf(q => base(q).lt('enriched_at', staleCutoff)),
      ]);

      // Derived rather than queried: pending is the complement of enriched,
      // so a fourth round trip would only add a chance of disagreeing.
      stats[platform] = { total, enriched, pending: total - enriched, stale };
    }

    return NextResponse.json(stats);
  } catch (error: any) {
    console.error('Error fetching enrich status:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch enrich status' },
      { status: 500 }
    );
  }
}
