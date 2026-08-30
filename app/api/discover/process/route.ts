import { NextRequest, NextResponse } from 'next/server';
import {
  startHashtagScraper,
  startTikTokHashtagScraper,
  waitForRun,
  getDatasetItems,
} from '@/lib/apify';
import { loadEntityExcludedHandles } from '@/lib/entityFilter';
import { extractAuthorHandles } from '@/lib/discoveryPosts';
import {
  extractAuthorMeta,
  summariseAuthorMetaCoverage,
  shouldHaltOnCoverage,
  MIN_FOLLOWER_COVERAGE,
  type SearchAuthorMeta,
} from '@/lib/tiktokAuthorMeta';
import { importScrapedProfiles } from '@/lib/profileImport';
import { discoveryImportPolicy } from '@/lib/discoveryPolicy';
import { normaliseRange, importStatusFor } from '@/lib/followerRange';
import { parseEnumParam, parseBoundedInt, parseBoolParam, firstError } from '@/lib/requestParams';
import {
  loadCachedMeasurements,
  loadKnownHandles,
  writeCandidates,
  touchRun,
  recordAuthorMetaCoverage,
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
 * Seconds Vercel is told this route may run for.
 *
 *   Vercel Hobby       60
 *   Vercel Pro        300
 *   Vercel Enterprise 900
 *
 * MUST BE A LITERAL. Next statically analyses segment config exports, so
 * neither `= SOME_CONST` nor `= Number(process.env.X)` compiles — both fail the
 * build with "Invalid segment configuration export detected". That is why this
 * cannot be the env-driven value even though the budget below can be.
 *
 * It is also INERT outside Vercel. Next does not enforce it; deployment
 * platforms read it from the build output. On `next dev` or a self-hosted
 * `next start` nothing consults it, so 300 here does not cap a local run.
 */
export const maxDuration = 300;

/**
 * When to stop starting new work, leaving room to write results and respond.
 *
 * Env-driven so one number does not have to satisfy two environments. Vercel
 * gets the default, derived from maxDuration; a local or self-hosted run sets
 * DISCOVERY_BUDGET_SECONDS higher, which is what a 200-result TikTok keyword
 * search needs — its search phase alone has been measured at 289s.
 *
 * A non-numeric or non-positive value falls back rather than producing NaN,
 * which would make every deadline comparison false and disable the budget
 * silently.
 */
function budgetSeconds(): number {
  const raw = Number(process.env.DISCOVERY_BUDGET_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : maxDuration - 30;
}

const BUDGET_MS = budgetSeconds() * 1000;

/** Handles per Apify profile-scrape run. */
const PROFILE_BATCH_SIZE = 50;

interface Funnel {
  candidatesFound: number;
  entityExcluded: number;
  alreadyKnown: number;
  cachedReject: number;
  /** Rejected on the free follower reading, before any profile scrape. */
  preScrapeOutOfBand: number;
  toScrape: number;
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + BUDGET_MS;

  try {
    const body = await request.json().catch(() => ({}));

    const runId = typeof body.runId === 'string' ? body.runId : '';
    // Honoured or rejected, never rewritten — see lib/requestParams.
    const platformP = parseEnumParam('platform', body.platform, ['instagram', 'tiktok'] as const, 'instagram');
    const sourceP = parseEnumParam('searchSource', body.searchSource, ['hashtag', 'keyword'] as const, 'hashtag');
    const haltP = parseBoolParam('haltOnLowCoverage', body.haltOnLowCoverage, true);
    const resultsP = parseBoundedInt('resultsPerHashtag', body.resultsPerHashtag,
      { min: 1, max: 500, fallback: 100 });

    const paramError = firstError(platformP, sourceP, haltP, resultsP);
    if (paramError) return NextResponse.json({ error: paramError }, { status: 400 });

    const platform = (platformP as { value: 'instagram' | 'tiktok' }).value;
    const searchSource = (sourceP as { value: 'hashtag' | 'keyword' }).value;
    const haltOnLowCoverage = (haltP as { value: boolean }).value;
    const resultsPerHashtag = (resultsP as { value: number }).value;

    // A keyword may legitimately contain spaces; only a tag gets # stripped.
    const rawTerm = String(body.hashtag ?? '').trim().toLowerCase();
    const hashtag = searchSource === 'keyword' ? rawTerm : rawTerm.replace(/^#/, '');
    /** Recency window. Off by default — a charged add-on, and a second variable. */
    const dateFilter = typeof body.dateFilter === 'string' && body.dateFilter
      ? body.dateFilter
      : undefined;
    const range = normaliseRange(body.minFollowers, body.maxFollowers);

    if (!runId) return NextResponse.json({ error: 'runId is required' }, { status: 400 });
    if (!hashtag) return NextResponse.json({ error: 'hashtag is required' }, { status: 400 });

    const empty: Funnel = {
      candidatesFound: 0, entityExcluded: 0, alreadyKnown: 0, cachedReject: 0,
      preScrapeOutOfBand: 0, toScrape: 0,
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
      ? await startTikTokHashtagScraper([hashtag], resultsPerHashtag, {
          keyword: searchSource === 'keyword',
          dateFilter,
        })
      : await startHashtagScraper([hashtag], resultsPerHashtag, searchSource === 'keyword');

    // Bounded by what remains of the budget, so a slow actor cannot consume
    // the whole request and leave nothing for the profile phase.
    const { datasetId } = await waitForRun(scrapeRunId, {
      timeoutMs: Math.max(10_000, deadlineAt - Date.now()),
    });
    if (!datasetId) throw new Error(`Hashtag scrape for #${hashtag} returned no dataset`);

    const posts = await getDatasetItems<unknown>(datasetId, resultsPerHashtag);
    const candidates = extractAuthorHandles(posts, platform);

    // Author metadata carried on the search item itself. TikTok only; Instagram
    // posts carry nothing about the account behind them.
    const authorMeta = platform === 'tiktok' ? extractAuthorMeta(posts) : new Map();
    const coverage = summariseAuthorMetaCoverage(authorMeta, posts);
    const halting = platform === 'tiktok' && shouldHaltOnCoverage(coverage, haltOnLowCoverage);
    // With the halt off and coverage partial, the filter still applies to the
    // authors that DID carry a reading. The rest fall through to a profile
    // scrape, which is the pre-halt behaviour and is what makes the probe safe.
    const usePreScrapeFilter = platform === 'tiktok';

    // Persisted before anything else can go wrong with this term. It is the
    // measurement the run exists to produce, and it was previously computed,
    // returned in a response, and lost.
    if (platform === 'tiktok') {
      await recordAuthorMetaCoverage(runId, hashtag, coverage);
    }

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

    // ── FF1: halt rather than fall back ────────────────────────────────────
    //
    // If the follower count is not on the search items, the pre-scrape filter
    // does not exist and every distinct author would need a profile scrape —
    // roughly 150 per term at $0.005 against a handful when the filter works.
    // That is a different actor's economics, and nobody chose them. Stopping
    // costs one search; falling back costs the difference, silently, on a bill.
    if (halting) {
      await touchRun(runId);
      return NextResponse.json({
        hashtag, platform, searchSource,
        cancelled: false, timedOut: false, extractionFailed: false,
        halted: true,
        haltReason:
          `authorMeta.fans is present on ${coverage.withFollowerCount} of ` +
          `${coverage.items} authors (${(coverage.followerCountRate * 100).toFixed(0)}%), ` +
          `below the ${(MIN_FOLLOWER_COVERAGE * 100).toFixed(0)}% needed to filter before ` +
          `scraping. Halted rather than scraping every author, which would cost about ` +
          `$${(coverage.items * 0.005).toFixed(2)} for this term alone. ` +
          `Re-run with the halt disabled to see the coverage breakdown instead.`,
        authorMetaCoverage: coverage,
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

      // The free follower reading, where the search item supplied one. This is
      // the whole economic case for clockworks: rejecting here costs nothing,
      // rejecting after a profile scrape costs $0.005 a head.
      const meta: SearchAuthorMeta | undefined = authorMeta.get(handle);
      if (!outcome && usePreScrapeFilter && meta && meta.followerCount !== null) {
        const status = importStatusFor(meta.followerCount, range);
        if (status === 'out_of_range_low' || status === 'out_of_range_high') {
          outcome = status === 'out_of_range_high' ? 'rejected_above_max' : 'rejected_below_floor';
          funnel.preScrapeOutOfBand++;
        }
      }

      if (outcome) {
        // Signals are recorded for every candidate, filtered on for none of
        // them. The first run reports what they WOULD have excluded; deciding
        // what to exclude comes after seeing those numbers.
        rows.push({
          handle,
          outcome,
          ...(meta ? {
            authorFollowerCount: meta.followerCount,
            authorTtSeller: meta.ttSeller,
            authorSignature: meta.signature,
            authorVerified: meta.verified,
          } : {}),
        });
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
      ...toScrape.map(handle => {
        const meta: SearchAuthorMeta | undefined = authorMeta.get(handle);
        return {
          handle,
          outcome: 'not_scraped' as CandidateOutcome,
          ...(meta ? {
            authorFollowerCount: meta.followerCount,
            authorTtSeller: meta.ttSeller,
            authorSignature: meta.signature,
            authorVerified: meta.verified,
          } : {}),
        };
      }),
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
    const measuredRows: CandidateRow[] = imported.measured.map(m => {
      // Carried through explicitly. writeCandidates upserts on
      // (run_id, platform, handle), so omitting these would overwrite the
      // signals written before the scrape with nulls — which is what happened
      // on the first TikTok probe: 29 candidates kept their bio and verified
      // flag, and the 20 that went on to be scraped lost theirs.
      const meta: SearchAuthorMeta | undefined = authorMeta.get(m.handle);
      return {
      handle: m.handle,
      followerCount: m.followerCount,
      authorFollowerCount: meta?.followerCount ?? null,
      authorTtSeller: meta?.ttSeller ?? null,
      authorSignature: meta?.signature ?? null,
      authorVerified: meta?.verified ?? null,
      // Discovery archives nothing, so imported_archive_* are no longer
      // produced here; they remain in the taxonomy for the rows written before
      // this change. Direction is preserved in the cache because it decides
      // re-admission: a below-min handle can grow into the band, an above-max
      // one only re-enters if the band's ceiling is raised.
      // Reconciled against the save, not recorded on intent. A handle that was
      // measured and attempted but not confirmed is 'import_failed' — billed,
      // with a follower reading, and no creator record.
      outcome:
        m.decision === 'cache_only'
          ? (m.status === 'out_of_range_high' ? 'rejected_above_max' : 'rejected_below_floor')
          : !m.saved ? 'import_failed'
          : m.status === 'active' ? 'imported_active'
          : 'unknown_size',
      };
    });

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

    // DD2a: a sample to eyeball, because an in-band import is not a result.
    // Country is NOT here: neither platform's profile payload carries it, and
    // it only appears after the intelligence pass.
    const importedSamples = imported.measured
      .filter(m => m.status === 'active' && m.decision === 'import' && m.saved)
      .slice(0, 15)
      .map(m => {
        const meta: SearchAuthorMeta | undefined = authorMeta.get(m.handle);
        return {
          handle: m.handle,
          followerCount: m.followerCount,
          signature: meta?.signature ?? null,
          ttSeller: meta?.ttSeller ?? null,
          verified: meta?.verified ?? null,
        };
      });

    return NextResponse.json({
      hashtag,
      platform,
      searchSource,
      extractionFailed: false,
      halted: false,
      authorMetaCoverage: coverage,
      importedSamples,
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
