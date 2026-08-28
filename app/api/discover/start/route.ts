import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { normaliseRange } from '@/lib/followerRange';

/**
 * Opens a Discovery run and returns its queue of search terms.
 *
 * Mirrors /api/brand-feed/start: the queue is built server-side and the client
 * walks it through the chunked runner, one term per call to
 * /api/discover/process.
 *
 * The run row is created HERE rather than after the run finishes, which is the
 * behaviour this replaces. Previously save-discovery-run was called only on
 * success (app/page.tsx:299), so an interrupted run left no trace at all —
 * which is why all 62 historical rows look complete. A row that exists from the
 * start can be reported as running, cancelled or abandoned.
 */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const platform: 'instagram' | 'tiktok' =
      body.platform === 'tiktok' ? 'tiktok' : 'instagram';
    const mode: 'niche' | 'sponsorship' =
      body.mode === 'sponsorship' ? 'sponsorship' : 'niche';

    const hashtags: string[] = Array.isArray(body.hashtags)
      ? ([...new Set(
          body.hashtags
            .map((h: unknown) => String(h ?? '').trim().toLowerCase().replace(/^#/, ''))
            .filter(Boolean),
        )] as string[])
      : [];

    if (hashtags.length === 0) {
      return NextResponse.json(
        { error: 'At least one hashtag or keyword is required' },
        { status: 400 },
      );
    }

    const resultsPerHashtag = Math.max(1, Math.min(Number(body.resultsPerHashtag) || 100, 500));
    const range = normaliseRange(body.minFollowers, body.maxFollowers);
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from('discovery_runs')
      .insert({
        hashtags,
        platform,
        // Populated for the first time. The column existed and the request
        // interface declared it, but neither the old route nor the page ever
        // sent it, so all 62 historical rows read NULL and sponsorship runs
        // are indistinguishable from niche ones in the log.
        discovery_mode: mode,
        results_per_hashtag: resultsPerHashtag,
        min_followers: range.min,
        max_followers: range.max,
        total_posts_found: 0,
        unique_handles_found: 0,
        profiles_scraped: 0,
        creators_in_range: 0,
        status: 'running',
        started_at: now,
        last_progress_at: now,
      })
      .select('id')
      .single();

    if (error || !data) {
      throw new Error(`Failed to open discovery run: ${error?.message}`);
    }

    return NextResponse.json({
      runId: data.id,
      platform,
      mode,
      range,
      resultsPerHashtag,
      items: hashtags.map(hashtag => ({ hashtag, platform })),
      count: hashtags.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to start discovery run';
    console.error('Discovery start error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
