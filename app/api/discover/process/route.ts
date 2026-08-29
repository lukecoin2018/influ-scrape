import { NextRequest, NextResponse } from 'next/server';
import {
  startHashtagScraper,
  startTikTokHashtagScraper,
  waitForRun,
  getDatasetItems,
} from '@/lib/apify';
import { loadEntityExcludedHandles } from '@/lib/entityFilter';
import { extractAuthorHandles } from '@/lib/discoveryPosts';
import { importScrapedProfiles } from '@/lib/profileImport';
import { discoveryImportPolicy } from '@/lib/discoveryPolicy';
import { normaliseRange } from '@/lib/followerRange';
import {
  loadCachedMeasurements,
  loadKnownHandles,
  writeCandidates,
  touchRun,
  shouldSkipCachedHandle,
  cacheKey,
  type CandidateRow,
  type CandidateOutcome,
} from '@/lib/discoveryRun';

/**
 * Processes ONE hashtag or keyword for a Discovery run.
 *
 * The chunked runner walks the queue and calls this once per term, mirroring
 * /api/brand-feed/process. Everything that used to run in the browser
 * (app/page.tsx) happens here instead, which is what makes the entity filter,
 * the reject cache, follower-range stamping and a Stop button possible at all.
 *
 * Cost order is deliberate: the two free database filters run before the
 * profile scrape, so an excluded handle costs nothing.
 *
 *   hashtag scrape -> extract -> entity filter -> known -> reject cache
 *     -> LOG CANDIDATES -> profile scrape in batches -> write measurements back
 */

/**
 * Seconds this route may run for. THE ONE NUMBER TO CHANGE PER PLAN.
 *
 *   Vercel Hobby       60   <- hard platform ceiling
 *   Vercel Pro        300
 *   Vercel Enterprise 900
 *
 * It must not exceed the plan's ceiling. If it does, the platform kills the
 * function while the budget below still believes it has time, so the graceful
 * partial-result path never runs and the request dies as a 504 — losing every
 * profile it already paid to scrape, which is exactly what the budget exists
 * to prevent.
 *
 * Written as a literal and not derived from another binding: Next statically
 * analyses segment config exports, and `export const maxDuration = SOME_CONST`
 * fails the build with "Invalid segment configuration export detected". The
 * budget below reads it back, so this is still the single number to change.
 */
export const maxDuration = 300;

/**
 * When to stop starting new work, leaving room to write results and respond.
 *
 * 30s of headroom: enough for the final candidate write-back and the response,
 * so the run ends by choice rather than by being killed.
 */
const BUDGET_MS = (maxDuration - 30) * 1000;

/** Handles per Apify profile-scrape run. */
const PROFILE_BATCH_SIZE = 50;

interface Funnel {
  candidatesFound: number;
  entityExcluded: number;
  alreadyKnown: number;
  cachedReject: number;
  toScrape: number;
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + BUDGET_MS;

  try {
    const body = await request.json().catch(() => ({}));

    const runId = typeof body.runId === 'string' ? body.runId : '';
    // A keyword may legitimately contain spaces; only a tag gets # stripped.
    const rawTerm = String(body.hashtag ?? '').trim().toLowerCase();
    const hashtag = body.searchSource === 'keyword' ? rawTerm : rawTerm.replace(/^#/, '');
    const platform: 'instagram' | 'tiktok' = body.platform === 'tiktok' ? 'tiktok' : 'instagram';
    const searchSource: 'hashtag' | 'keyword' =
      body.searchSource === 'keyword' && platform === 'instagram' ? 'keyword' : 'hashtag';
    const resultsPerHashtag = Math.max(1, Math.min(Number(body.resultsPerHashtag) || 100, 500));
    const range = normaliseRange(body.minFollowers, body.maxFollowers);

    if (!runId) return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    if (!hashtag) return NextResponse.json({ error: 'hashtag is required' }, { status: 400 });

    const empty: Funnel = {
      candidatesFound: 0, entityExcluded: 0, alreadyKnown: 0, cachedReject: 0, toScrape: 0,
    };

    // ── Cancellation check A: nothing spent yet ────────────────────────────
    if (request.signal?.aborted) {
      return NextResponse.json({
        hashtag, platform, searchSource, cancelled: true, timedOut: false,
        postsFound: 0, ...empty, imported: null, extractionFailed: false,
        durationMs: Date.now() - startedAt,
      });
    }

    // ── 1. Hashtag / keyword scrape ────────────────────────────────────────
    const { runId: scrapeRunId } = platform === 'tiktok'
      ? await startTikTokHashtagScraper([hashtag], resultsPerHashtag)
      : await startHashtagScraper([hashtag], resultsPerHashtag, searchSource === 'keyword');

    // Bounded by what remains of the budget, so a slow actor cannot consume
    // the whole request and leave nothing for the profile phase.
    const { datasetId } = await waitForRun(scrapeRunId, {
      timeoutMs: Math.max(10_000, deadlineAt - Date.now()),
    });
    if (!datasetId) throw new Error(`Hashtag scrape for #${hashtag} returned no dataset`);

    const posts = await getDatasetItems<unknown>(datasetId, resultsPerHashtag);
    const candidates = extractAuthorHandles(posts, platform);

    // Posts came back and not one of them yielded an author handle.
    //
    // extractAuthorHandles reads ownerUsername for Instagram, and returns an
    // empty array rather than throwing when the field is absent — which is
    // indistinguishable, downstream, from a term nobody posted under. The two
    // must not look alike: one is a term with no reach, the other is the
    // scraper's output shape having changed underneath us. Instagram's own
    // documentation warns the keyword dataset differs from the hashtag one, so
    // this is the specific failure keyword search was expected to risk.
    //
    // Reported rather than thrown: the scrape is already paid for, and the post
    // count is the diagnostic that says which of the two happened. Throwing
    // would discard it.
    if (posts.length > 0 && candidates.length === 0) {
      await touchRun(runId);
      return NextResponse.json({
        hashtag,
        platform,
        searchSource,
        cancelled: false,
        timedOut: false,
        extractionFailed: true,
        extractionError:
          `${posts.length} posts returned but no author handle could be read from any of them. ` +
          `Expected ownerUsername on each ${platform} post` +
          (searchSource === 'keyword'
            ? '; Instagram\'s keyword dataset differs from its hashtag dataset, so the field may be named differently or absent.'
            : '.'),
        postsFound: posts.length,
        ...empty,
        imported: null,
        durationMs: Date.now() - startedAt,
      });
    }

    // ── 2. Free filters, before any profile scrape ─────────────────────────
    const [entityExcluded, known, cached] = await Promise.all([
      loadEntityExcludedHandles(candidates, platform),
      loadKnownHandles(candidates, platform),
      loadCachedMeasurements(candidates, platform),
    ]);

    const rows: CandidateRow[] = [];
    const toScrape: string[] = [];
    const funnel: Funnel = { ...empty, candidatesFound: candidates.length };

    for (const handle of candidates) {
      // Precedence is the order the filters run, so each handle gets exactly
      // one outcome even when several would apply.
      let outcome: CandidateOutcome | null = null;

      if (entityExcluded.has(handle)) {
        outcome = 'entity_excluded';
        funnel.entityExcluded++;
      } else if (known.has(handle)) {
        // Known handles are skipped rather than re-stamped. Re-importing an
        // existing handle with a changed status is the cross-table move that
        // duplicates a creator across the live and archive tables — see the
        // promotion hazard in docs/deferred-cleanups.md. Until that is fixed,
        // Discovery only ever imports handles it has never seen.
        outcome = 'already_known';
        funnel.alreadyKnown++;
      } else if (shouldSkipCachedHandle(cached.get(cacheKey(platform, handle)), range)) {
        outcome = 'cached_reject';
        funnel.cachedReject++;
      }

      if (outcome) {
        rows.push({ handle, outcome });
      } else {
        toScrape.push(handle);
      }
    }
    funnel.toScrape = toScrape.length;

    // ── 3. Log every candidate BEFORE the profile scrape ───────────────────
    // Written first so a cancelled or timed-out run still records what it
    // found. Handles that never get scraped are marked not_scraped and carry
    // no follower count, so they never enter the reject cache.
    await writeCandidates(runId, hashtag, platform, [
      ...rows,
      ...toScrape.map(handle => ({ handle, outcome: 'not_scraped' as CandidateOutcome })),
    ]);

    // ── Cancellation check B: the hashtag scrape is paid for, the profile
    //    scrape has not started. Its candidates are kept and logged above.
    const outOfBudget = Date.now() >= deadlineAt;
    if (request.signal?.aborted || outOfBudget) {
      await touchRun(runId);
      return NextResponse.json({
        hashtag, platform, searchSource,
        cancelled: request.signal?.aborted === true,
        timedOut: !request.signal?.aborted && outOfBudget,
        postsFound: posts.length, ...funnel, imported: null,
        extractionFailed: false,
        durationMs: Date.now() - startedAt,
      });
    }

    // ── 4. Profile scrape. Cancellation check C lives inside the batch loop
    //    in profileImportCore, before each batch's Apify call, so pressing
    //    Stop does not leave eighteen billable runs in flight.
    const imported = await importScrapedProfiles(toScrape, {
      range,
      platform,
      discoveredViaHashtags: [hashtag],
      batchSize: PROFILE_BATCH_SIZE,
      signal: request.signal,
      deadlineAt,
      policy: discoveryImportPolicy,
    });

    // ── 5. Write measurements back ─────────────────────────────────────────
    // Upserts onto the not_scraped rows written in step 3.
    const measuredRows: CandidateRow[] = imported.measured.map(m => ({
      handle: m.handle,
      followerCount: m.followerCount,
      outcome:
        m.decision === 'cache_only' ? 'rejected_below_floor'
        : m.status === 'active' ? 'imported_active'
        : m.status === 'out_of_range_high' ? 'imported_archive_high'
        : m.status === 'out_of_range_low' ? 'imported_archive_low'
        : 'unknown_size',
    }));

    // Submitted, its batch returned, but the actor produced no profile for it —
    // private, deleted or renamed.
    //
    // Computed against scrapedHandles, not against the whole input: handles in
    // batches that were never reached (cancelled, timed out) or that threw are
    // genuinely unknown, and keep the not_scraped row written in step 3. Only
    // handles a completed batch actually covered can be called missing.
    const returned = new Set(imported.measured.map(m => m.handle));
    const missingRows: CandidateRow[] = imported.scrapedHandles
      .filter(h => !returned.has(h))
      .map(handle => ({ handle, outcome: 'scrape_missing' as CandidateOutcome }));

    await writeCandidates(runId, hashtag, platform, [...measuredRows, ...missingRows]);
    await touchRun(runId);

    return NextResponse.json({
      hashtag,
      platform,
      searchSource,
      extractionFailed: false,
      cancelled: imported.cancelled,
      timedOut: imported.timedOut,
      postsFound: posts.length,
      ...funnel,
      scrapeMissing: missingRows.length,
      imported: {
        attempted: imported.attempted,
        saved: imported.saved,
        failed: imported.failed,
        inRange: imported.inRange,
        outOfRangeHigh: imported.outOfRangeHigh,
        outOfRangeLow: imported.outOfRangeLow,
        unknownSize: imported.unknownSize,
        cachedBelowFloor: imported.cacheOnly.length,
        outOfRangeSamples: imported.outOfRangeSamples,
        unknownSizeSamples: imported.unknownSizeSamples,
        errors: imported.errors,
      },
      durationMs: Date.now() - startedAt,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Discovery processing failed';
    console.error('Discovery process error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
