import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getCreatorsNeedingReembedding } from '@/lib/embeddingStaleness';

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('creators')
      .select('embedded_at, id')
      .eq('import_status', 'active');

    if (error) throw error;

    const total = data?.length || 0;
    const embedded = data?.filter(c => c.embedded_at).length || 0;
    const pending = total - embedded;

    // Count enriched creators (have at least one social_profile with enriched_at)
    const { data: enrichedProfiles } = await supabase
      .from('social_profiles')
      .select('creator_id')
      .eq('import_status', 'active')
      .not('enriched_at', 'is', null);

    const enrichedCreatorIds = new Set(
      (enrichedProfiles || []).map((p: any) => p.creator_id)
    );

    // Enriched but not yet embedded
    const enrichedNotEmbedded = data?.filter(
      c => !c.embedded_at && enrichedCreatorIds.has(c.id)
    ).length || 0;

    const needsReembedding = (await getCreatorsNeedingReembedding()).length;

    return NextResponse.json({
      total,
      embedded,
      pending,
      enriched_not_embedded: enrichedNotEmbedded,
      needs_reembedding: needsReembedding,
    });
  } catch (error: any) {
    console.error('Error fetching embedding status:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch embedding status' },
      { status: 500 }
    );
  }
}
