import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { fetchAllRows } from '@/lib/supabasePaging';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    // Total social profiles
    const { count: total } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('import_status', 'active');

    // Analyzed (has intelligence_updated_at set)
    const { count: analyzed } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('import_status', 'active')
      .not('intelligence_updated_at', 'is', null);

    // With email detected
    const { count: withEmail } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('import_status', 'active')
      .not('detected_email', 'is', null);

    // With location detected
    const { count: withLocation } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('import_status', 'active')
      .not('detected_country', 'is', null);

    // With AI summary
    const { count: withAiSummary } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .eq('import_status', 'active')
      .not('ai_summary', 'is', null);

    // Needs re-analysis: enriched more recently than the last intelligence run.
    // PostgREST filters can't compare two columns directly, so pull the two
    // timestamp columns and compare in JS. NULL intelligence_updated_at is
    // excluded here — those profiles are already covered by "Not yet analyzed".
    // Genuinely needs the rows: enriched_at > intelligence_updated_at is a
    // column-to-column comparison PostgREST cannot express as a filter.
    // Paged rather than capped — a plain select stops at 50,000 with no
    // signal, which would silently under-report the backlog.
    const reanalysisCandidates = await fetchAllRows<{ enriched_at: string; intelligence_updated_at: string }>(() => supabase
      .from('social_profiles')
      .select('enriched_at, intelligence_updated_at')
      .eq('import_status', 'active')
      .not('enriched_at', 'is', null)
      .not('intelligence_updated_at', 'is', null)
      .order('id', { ascending: true }));

    const needsReanalysis = reanalysisCandidates.filter(
      (p) => new Date(p.enriched_at as string).getTime() > new Date(p.intelligence_updated_at as string).getTime()
    ).length;

    return NextResponse.json({
      total: total ?? 0,
      analyzed: analyzed ?? 0,
      pending: (total ?? 0) - (analyzed ?? 0),
      with_email: withEmail ?? 0,
      with_location: withLocation ?? 0,
      with_ai_summary: withAiSummary ?? 0,
      needs_reanalysis: needsReanalysis,
    });
  } catch (error) {
    console.error('Intelligence status error:', error);
    return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 });
  }
}
