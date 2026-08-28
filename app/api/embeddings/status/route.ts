import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getCreatorsNeedingReembedding } from '@/lib/embeddingStaleness';
import { fetchAllRows } from '@/lib/supabasePaging';

export async function GET() {
  try {
    // Counted server-side: this only ever needed three numbers, and a plain
    // select is capped at 50,000 rows with no signal when it truncates.
    const countCreators = async (filters: (q: any) => any) => {
      const { count, error } = await filters(
        supabase.from('creators').select('*', { count: 'exact', head: true })
      );
      if (error) throw error;
      return count ?? 0;
    };

    const [total, embedded] = await Promise.all([
      countCreators(q => q.eq('import_status', 'active')),
      countCreators(q => q.eq('import_status', 'active').not('embedded_at', 'is', null)),
    ]);
    const pending = total - embedded;

    // "Enriched but not yet embedded" is a set intersection across two tables,
    // which PostgREST cannot express as a filter, so both sides genuinely need
    // their rows. Paged rather than capped — fetchAllRows requires a
    // deterministic order, or pages can overlap and drop rows.
    const [enrichedProfiles, unembedded] = await Promise.all([
      fetchAllRows<{ creator_id: string }>(() => supabase
        .from('social_profiles')
        .select('creator_id')
        .eq('import_status', 'active')
        .not('enriched_at', 'is', null)
        .order('id', { ascending: true })),
      fetchAllRows<{ id: string }>(() => supabase
        .from('creators')
        .select('id')
        .eq('import_status', 'active')
        .is('embedded_at', null)
        .order('id', { ascending: true })),
    ]);

    const enrichedCreatorIds = new Set(enrichedProfiles.map(p => p.creator_id));
    const enrichedNotEmbedded = unembedded.filter(c => enrichedCreatorIds.has(c.id)).length;

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
