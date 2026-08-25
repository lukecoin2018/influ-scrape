import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const staleDays = Math.max(1, parseInt(searchParams.get('staleDays') || '90', 10) || 90);

    const { data, error } = await supabase
      .from('social_profiles')
      .select('platform, enriched_at')
      .eq('import_status', 'active');

    if (error) throw error;

    const stats = {
      instagram: { total: 0, enriched: 0, pending: 0, stale: 0 },
      tiktok: { total: 0, enriched: 0, pending: 0, stale: 0 },
    };

    const staleCutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;

    for (const row of data || []) {
      const platform = row.platform as 'instagram' | 'tiktok';
      if (!stats[platform]) continue;
      stats[platform].total++;
      if (row.enriched_at) {
        stats[platform].enriched++;
        if (new Date(row.enriched_at).getTime() < staleCutoff) {
          stats[platform].stale++;
        }
      } else {
        stats[platform].pending++;
      }
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
