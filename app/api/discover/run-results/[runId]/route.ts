import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * The creators one Discovery run actually imported.
 *
 * The Results tab previously read /api/database/get-creators filtered by
 * platform and follower band, which has no run dimension — so after a run that
 * imported twelve creators it rendered up to five hundred rows matching the
 * band, and labelled them as the run's results. On a first run that is actively
 * misleading, since the pre-existing database slice is exactly what you are
 * trying to distinguish the run's output from.
 *
 * discovery_candidates records the outcome of every candidate per run, so the
 * set is exact rather than inferred. The alternative — filtering by
 * first_discovered_at since the run started — would sweep in anything else that
 * wrote in the same window, including a concurrent enrichment or import.
 *
 * Only 'imported_active' is returned: in-band creators, which is what the tab
 * showed before. Archived and cached candidates are reported as counts in the
 * funnel and deliberately do not appear here as creator rows.
 */

const LOOKUP_CHUNK = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const { runId } = await context.params;
    if (!runId) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }

    const { data: candidates, error: candidateError } = await supabase
      .from('discovery_candidates')
      .select('handle, platform')
      .eq('run_id', runId)
      .eq('outcome', 'imported_active');

    if (candidateError) {
      throw new Error(`discovery_candidates lookup failed: ${candidateError.message}`);
    }

    const rows = candidates || [];
    if (rows.length === 0) {
      return NextResponse.json({ creators: [], total: 0, handles: [] });
    }

    // A run targets one platform, but read it from the rows rather than
    // assuming: the caller's platform state can change while a run is settling.
    const platform = rows[0].platform === 'tiktok' ? 'tiktok' : 'instagram';
    const handleColumn = platform === 'tiktok' ? 'tiktok_handle' : 'instagram_handle';
    const handles = [...new Set(rows.map(r => String(r.handle).toLowerCase()))];

    const creators: Record<string, unknown>[] = [];
    for (const batch of chunk(handles, LOOKUP_CHUNK)) {
      const { data, error } = platform === 'tiktok'
        ? await supabase.from('v_creator_summary').select('*').in('tiktok_handle', batch)
        : await supabase.from('v_creator_summary').select('*').in('instagram_handle', batch);

      if (error) throw new Error(`creator lookup failed: ${error.message}`);
      creators.push(...(data || []));
    }

    // Sorted the way the old query was, so the tab reads the same.
    creators.sort(
      (a, b) => (Number(b.total_followers) || 0) - (Number(a.total_followers) || 0),
    );

    return NextResponse.json({
      creators,
      total: creators.length,
      handles,
      platform,
      handleColumn,
      /** Imported but not found in the view — a write that did not land. */
      missing: handles.length - creators.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load run results';
    console.error('Discovery run-results error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
