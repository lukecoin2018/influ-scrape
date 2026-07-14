import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    // Total social profiles
    const { count: total } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true });

    // Analyzed (has intelligence_updated_at set)
    const { count: analyzed } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .not('intelligence_updated_at', 'is', null);

    // With email detected
    const { count: withEmail } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .not('detected_email', 'is', null);

    // With location detected
    const { count: withLocation } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .not('detected_country', 'is', null);

    // With AI summary
    const { count: withAiSummary } = await supabase
      .from('social_profiles')
      .select('*', { count: 'exact', head: true })
      .not('ai_summary', 'is', null);

    // Needs re-analysis: enriched more recently than the last intelligence run.
    // PostgREST filters can't compare two columns directly, so pull the two
    // timestamp columns and compare in JS. NULL intelligence_updated_at is
    // excluded here — those profiles are already covered by "Not yet analyzed".
    const { data: reanalysisCandidates } = await supabase
      .from('social_profiles')
      .select('enriched_at, intelligence_updated_at')
      .not('enriched_at', 'is', null)
      .not('intelligence_updated_at', 'is', null);

    const needsReanalysis = (reanalysisCandidates || []).filter(
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
