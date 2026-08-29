import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { normaliseRange } from '@/lib/followerRange';
import {
  parseEnumParam,
  parseBoundedInt,
  parseBoolParam,
  firstError,
} from '@/lib/requestParams';

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

    // Honoured or rejected, never rewritten. A run started as a keyword search
    // was once silently recorded and executed as a hashtag one because this
    // guard carried a stale platform clause; nothing reported the change.
    const platformP = parseEnumParam('platform', body.platform, ['instagram', 'tiktok'] as const, 'instagram');
    const modeP = parseEnumParam('mode', body.mode, ['niche', 'sponsorship'] as const, 'niche');
    const sourceP = parseEnumParam('searchSource', body.searchSource, ['hashtag', 'keyword'] as const, 'hashtag');
    const haltP = parseBoolParam('haltOnLowCoverage', body.haltOnLowCoverage, true);

    const paramError = firstError(platformP, modeP, sourceP, haltP);
    if (paramError) return NextResponse.json({ error: paramError }, { status: 400 });

    const platform = (platformP as { value: 'instagram' | 'tiktok' }).value;
    const mode = (modeP as { value: 'niche' | 'sponsorship' }).value;
    const requestedSource = (sourceP as { value: 'hashtag' | 'keyword' }).value;
    const haltOnLowCoverage = (haltP as { value: boolean }).value;

    // Sponsorship mode has no keyword path — its brand extraction is
    // unconverted. Rejected rather than downgraded, so the caller learns.
    if (requestedSource === 'keyword' && mode !== 'niche') {
      return NextResponse.json(
        { error: 'searchSource="keyword" is only supported in niche mode.' },
        { status: 400 },
      );
    }
    const searchSource = requestedSource;

    const hashtags: string[] = Array.isArray(body.hashtags)
      ? ([...new Set(
          body.hashtags
            // Keywords keep their spaces; only tags get the leading # stripped.
            .map((h: unknown) => {
              const raw = String(h ?? '').trim().toLowerCase();
              return searchSource === 'keyword' ? raw : raw.replace(/^#/, '');
            })
            .filter(Boolean),
        )] as string[])
      : [];

    if (hashtags.length === 0) {
      return NextResponse.json(
        { error: 'At least one hashtag or keyword is required' },
        { status: 400 },
      );
    }

    const resultsP = parseBoundedInt('resultsPerHashtag', body.resultsPerHashtag,
      { min: 1, max: 500, fallback: 100 });
    if (!resultsP.ok) return NextResponse.json({ error: resultsP.error }, { status: 400 });
    const resultsPerHashtag = resultsP.value;
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
        search_source: searchSource,
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
      searchSource,
      range,
      resultsPerHashtag,
      // Reported rather than applied in silence.
      resultsClamped: resultsP.clamped === true,
      resultsRequested: resultsP.requested ?? resultsPerHashtag,
      items: hashtags.map(hashtag => ({ hashtag, platform, searchSource })),
      count: hashtags.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to start discovery run';
    console.error('Discovery start error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
