import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const { platform, mode, batchSize = 25, handles = [] } = await request.json();

    if (!platform) {
      return NextResponse.json({ error: 'platform is required' }, { status: 400 });
    }

    let resultHandles: string[] = [];

    if (mode === 'specific') {
      resultHandles = handles
        .map((h: string) => h.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean);
    } else if (mode === 'featured_first') {
      // Get featured creator IDs first
      const { data: featuredCreators } = await supabase
        .from('creators')
        .select('id')
        .eq('is_featured', true);

      const featuredIds = (featuredCreators || []).map((c: any) => c.id);

      // Get featured profiles not yet enriched
      let featuredHandles: string[] = [];
      if (featuredIds.length > 0) {
        const { data: featuredProfiles } = await supabase
          .from('social_profiles')
          .select('handle')
          .eq('platform', platform)
          .is('enriched_at', null)
          .in('creator_id', featuredIds)
          .limit(batchSize);

        featuredHandles = (featuredProfiles || []).map((p: any) => p.handle);
      }

      // Fill remaining slots with non-featured un-enriched
      const remaining = batchSize - featuredHandles.length;
      if (remaining > 0) {
        const { data: otherProfiles } = await supabase
          .from('social_profiles')
          .select('handle')
          .eq('platform', platform)
          .is('enriched_at', null)
          .not('handle', 'in', `(${featuredHandles.map(h => `"${h}"`).join(',')})`)
          .limit(remaining);

        const otherHandles = (otherProfiles || []).map((p: any) => p.handle);
        resultHandles = [...featuredHandles, ...otherHandles];
      } else {
        resultHandles = featuredHandles;
      }
    } else {
      // not_enriched (default)
      const { data: profiles } = await supabase
        .from('social_profiles')
        .select('handle')
        .eq('platform', platform)
        .is('enriched_at', null)
        .limit(batchSize);

      resultHandles = (profiles || []).map((p: any) => p.handle);
    }

    return NextResponse.json({
      handles: resultHandles,
      count: resultHandles.length,
    });
  } catch (error: any) {
    console.error('Error starting enrichment:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to start enrichment' },
      { status: 500 }
    );
  }
}
