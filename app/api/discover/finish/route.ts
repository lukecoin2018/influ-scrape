import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { totalsFromCandidates } from '@/lib/discoveryRunTotals';

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

    // Everything except the post count is DERIVED from discovery_candidates
    // rather than taken from the request.
    //
    // The client used to supply all six. It read its per-item results out of a
    // ref synced from React state by an effect, and called this route in the
    // same async continuation in which the runner's loop resolved — before
    // React had re-rendered — so the ref held a prefix and a two-term run
    // reported one term's numbers as the whole run. Reading the log here means
    // the counters cannot disagree with it whatever the client does.
    //
    // Paged because a run can produce more candidate rows than one PostgREST
    // response returns, and a truncated read would silently under-count.
    const candidateRows: { outcome: string }[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .from('discovery_candidates')
        .select('outcome')
        .eq('run_id', runId)
        .range(offset, offset + 999);

      if (error) throw new Error(`candidate read failed: ${error.message}`);
      const page = data || [];
      candidateRows.push(...page);
      if (page.length < 1000) break;
    }

    const derived = totalsFromCandidates(candidateRows);

    const totals = {
      // Posts are the scrape's input, not its output: a post yielding no
      // candidate leaves no row, so this one still comes from the client.
      total_posts_found: Math.max(0, Number(body.totalPostsFound) || 0),
      unique_handles_found: derived.uniqueHandlesFound,
      profiles_scraped: derived.profilesScraped,
      creators_in_range: derived.creatorsInRange,
      new_creators_added: derived.newCreatorsAdded,
      existing_creators_updated: derived.existingCreatorsUpdated,
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
