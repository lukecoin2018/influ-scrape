import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('social_profiles')
      .select('platform, enriched_at');

    if (error) throw error;

    const stats = {
      instagram: { total: 0, enriched: 0, pending: 0 },
      tiktok: { total: 0, enriched: 0, pending: 0 },
    };

    for (const row of data || []) {
      const platform = row.platform as 'instagram' | 'tiktok';
      if (!stats[platform]) continue;
      stats[platform].total++;
      if (row.enriched_at) {
        stats[platform].enriched++;
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
