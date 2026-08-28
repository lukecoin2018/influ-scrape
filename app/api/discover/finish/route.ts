import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

/**
 * Closes a Discovery run.
 *
 * Called by the client once the chunked runner settles, because a run spans
 * many per-hashtag calls and no single one of them knows it was the last.
 *
 * A closed tab therefore leaves the row at 'running' forever. That is a known
 * and accepted state rather than an oversight — nothing sweeps it. It is
 * identifiable instead: each /api/discover/process call advances
 * last_progress_at, so an abandoned run is one still marked 'running' that has
 * been silent longer than any live run plausibly could be.
 *
 * Deriving that on read rather than sweeping keeps the record honest. A sweep
 * would rewrite history on a schedule whose threshold is itself a guess, and a
 * row rewritten to 'cancelled' could no longer be told apart from one the user
 * actually stopped. The query is in docs/migrations/.
 */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const runId = typeof body.runId === 'string' ? body.runId : '';

    if (!runId) {
      return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    }

    const status = body.status === 'cancelled' ? 'cancelled' : 'complete';

    const totals = {
      total_posts_found: Math.max(0, Number(body.totalPostsFound) || 0),
      unique_handles_found: Math.max(0, Number(body.uniqueHandlesFound) || 0),
      profiles_scraped: Math.max(0, Number(body.profilesScraped) || 0),
      creators_in_range: Math.max(0, Number(body.creatorsInRange) || 0),
      new_creators_added: Math.max(0, Number(body.newCreatorsAdded) || 0),
      existing_creators_updated: Math.max(0, Number(body.existingCreatorsUpdated) || 0),
    };

    const now = new Date().toISOString();

    const { error } = await supabase
      .from('discovery_runs')
      .update({ ...totals, status, completed_at: now, last_progress_at: now })
      .eq('id', runId);

    if (error) throw new Error(`Failed to close discovery run: ${error.message}`);

    return NextResponse.json({ runId, status, ...totals });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to finish discovery run';
    console.error('Discovery finish error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
