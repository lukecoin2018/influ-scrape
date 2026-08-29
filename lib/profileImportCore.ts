import { mapProfileToCreator, mapTikTokProfile } from './apify';
import { importStatusFor, type FollowerRange, type ImportStatus } from './followerRange';
import { looseHandle as norm } from './handles';
import type { InstagramProfile } from './types';

/**
 * Batching, cancellation and classification for a profile import — pure core.
 *
 * Split out from profileImport.ts for the same reason chunkedRunnerCore is
 * split out of useChunkedRunner: the loop has a cancellation guard whose whole
 * job is to NOT make a billable call, and that is only testable if the calls
 * are observable. Both effects are injected here with no defaults, so this
 * module never reaches the Apify client or supabase — a unit test needs
 * neither credentials nor a database.
 *
 * profileImport.ts is the thin wrapper that binds the real implementations.
 */

import type { ImportableCreator, ImportResult } from './creatorImport';

/** Out-of-range examples surfaced per direction — high and low, separately. */
export const SAMPLES_PER_DIRECTION = 12;

/**
 * Unmeasured examples surfaced per run.
 *
 * Its own cap rather than a third share of SAMPLES_PER_DIRECTION. On a clean
 * pool unmeasured handles are rare and sharing costs nothing, but hashtag and
 * keyword discovery hits private and deleted accounts constantly — and those
 * would crowd out the below-min samples, which are the ones worth eyeballing
 * for promotion.
 */
export const UNKNOWN_SIZE_SAMPLE_CAP = 12;

export type ImportDecision = 'import' | 'cache_only';

/**
 * Decides what happens to a scraped profile once its status is known.
 *
 * 'import' writes a creator record, routed by import_status. 'cache_only'
 * writes nothing but returns the handle in `cacheOnly`, for callers keeping a
 * reject cache — enough never to re-scrape the handle, without manufacturing a
 * creator record for someone who is not one.
 *
 * Defaults to always importing, which is what brand-feed has always done: a
 * handle a brand chose to feature is qualified by that selection even when it
 * sits outside the band.
 */
export type ImportPolicy = (
  profile: MappedProfile,
  status: ImportStatus
) => ImportDecision;

/** Exactly what the reject cache needs to skip a handle next time. Nothing more. */
export interface CacheOnlyEntry {
  handle: string;
  platform: string;
  followerCount: number;
}

/**
 * Per-handle record of everything actually measured.
 *
 * The counters say how many; this says which. The Discovery route needs it to
 * write follower_count and a per-handle outcome back to discovery_candidates —
 * aggregates cannot be attributed to handles after the fact.
 *
 * `cacheOnly` is the subset of this where decision === 'cache_only'. Kept as
 * its own list because it is the cache write specifically, and carries only
 * the three fields that write needs.
 */
export interface MeasuredHandle {
  handle: string;
  platform: string;
  followerCount: number;
  status: ImportStatus;
  decision: ImportDecision;
  /**
   * Whether a creator record was actually written.
   *
   * True only when saveCreators confirmed this handle. A 'cache_only' decision
   * is false by design — nothing was attempted for it.
   *
   * This exists because the outcome used to be recorded on INTENT: the handle
   * was pushed here before saveCreators ran, so a save that failed for one
   * creator still reported it as imported. saveDiscoveredCreators catches per
   * creator and counts failures, so the funnel could report an import that
   * never happened — and on a run whose whole purpose is reading the funnel,
   * that is the worst possible place for a silent discrepancy.
   */
  saved: boolean;
}

export interface ImportOutcome {
  attempted: number;
  saved: number;
  failed: number;
  inRange: number;
  outOfRangeHigh: number;
  outOfRangeLow: number;
  /** Followers not measured — a failed or private scrape, not a small account. */
  unknownSize: number;
  /** High and low only. Unmeasured handles have their own bucket below. */
  outOfRangeSamples: { handle: string; followerCount: number; status: string }[];
  unknownSizeSamples: { handle: string; followerCount: number }[];
  /** Observed but deliberately not imported, per the policy. */
  cacheOnly: CacheOnlyEntry[];
  /** Every handle a profile came back for, with its verdict. */
  measured: MeasuredHandle[];
  /**
   * Handles whose batch was submitted AND returned successfully.
   *
   * Lets a caller tell "the actor returned nothing for this handle" from
   * "this handle was never reached" — the two are indistinguishable from the
   * input list alone once a run is cancelled or times out. Excludes batches
   * that threw: those handles were billed but produced no data, which is a
   * batch failure rather than a missing profile.
   */
  scrapedHandles: string[];
  errors: string[];
  /** True when a batch was skipped because the signal aborted. */
  cancelled: boolean;
  /** True when a batch was skipped because the run budget ran out. */
  timedOut: boolean;
}

export interface ProfileImportCoreOptions {
  range: FollowerRange;
  platform: 'instagram' | 'tiktok';
  /** Provenance written to social_profiles.discovered_via_hashtags. */
  discoveredViaHashtags: string[];
  /**
   * Handles per Apify profile-scrape run.
   *
   * Defaults to Infinity — one run for everything — which is what brand-feed
   * has always done and keeps it on a single Apify run. Discovery passes 50:
   * it produces 600-900 handles per hashtag against brand-feed's cap of 60, and
   * one run of that size is both slow and all-or-nothing.
   */
  batchSize?: number;
  /**
   * Aborts the run between batches.
   *
   * Checked at the top of each iteration, BEFORE that batch's scrape is
   * started, because the thing worth preventing is a billable Apify run rather
   * than wasted local work. A batch already in flight when the signal fires is
   * already paid for and is allowed to finish; only its successors are skipped.
   */
  signal?: AbortSignal;
  /** Called after each batch with handles processed so far and the total. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Routes each scraped profile. Omit for the previous behaviour — import
   * everything — which is what brand-feed relies on.
   */
  policy?: ImportPolicy;
  /**
   * Epoch milliseconds after which no NEW batch is started.
   *
   * A serverless request has a hard wall, and one Discovery hashtag can be a
   * hashtag scrape plus eighteen profile batches. Without a budget the request
   * is killed mid-batch and everything it learned — including which handles it
   * already paid to measure — is lost. Stopping voluntarily returns the same
   * honest partial counts a cancellation does.
   *
   * Checked after the abort signal, so a user pressing Stop is reported as a
   * cancellation rather than a timeout even if both are true at once.
   */
  deadlineAt?: number;
  /** Injectable clock, so the deadline branch is testable without waiting. */
  now?: () => number;
  /**
   * Seam over the Apify round trip: start a run, wait for it, read the dataset.
   *
   * Injectable so the batching and cancellation logic can be tested without a
   * live scrape — in particular so a test can assert that no FURTHER scrape is
   * started after an abort, which a test on the return value alone cannot see.
   */
  scrapeBatch: (handles: string[]) => Promise<unknown[]>;
  /**
   * Seam over the database write, for the same reason as scrapeBatch: the
   * batching and cancellation behaviour has to be testable without writing
   * rows. Both default to the real implementation, so production callers pass
   * neither.
   */
  saveCreators: (creators: ImportableCreator[], platform: string) => Promise<ImportResult>;
}

/**
 * The subset of a mapped profile this module reads.
 *
 * Both mappers satisfy it structurally. The Instagram mapper returns
 * isBusinessAccount and categoryName; the TikTok one returns platformData and
 * omits the other two, since TikTok exposes neither. Declaring the union here
 * rather than widening either mapper keeps both of them untouched by this move.
 */
export interface MappedProfile {
  handle: string;
  fullName: string;
  bio: string;
  followerCount: number;
  followingCount: number;
  postsCount: number;
  engagementRate: number | null;
  isVerified: boolean;
  profilePicUrl: string;
  profileUrl: string;
  website: string;
  isBusinessAccount?: boolean;
  categoryName?: string;
  platformData?: Record<string, unknown>;
}

export const EMPTY_IMPORT_OUTCOME: ImportOutcome = {
  attempted: 0, saved: 0, failed: 0, inRange: 0, outOfRangeHigh: 0, outOfRangeLow: 0,
  unknownSize: 0, outOfRangeSamples: [], unknownSizeSamples: [], cacheOnly: [],
  measured: [], scrapedHandles: [], errors: [], cancelled: false, timedOut: false,
};

function chunk<T>(items: T[], size: number): T[][] {
  if (!Number.isFinite(size) || size <= 0 || size >= items.length) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runProfileImport(
  handles: string[],
  options: ProfileImportCoreOptions
): Promise<ImportOutcome> {
  const {
    range,
    platform,
    discoveredViaHashtags,
    batchSize = Infinity,
    signal,
    onProgress,
    scrapeBatch,
    saveCreators,
    policy = () => 'import',
    deadlineAt,
    now = Date.now,
  } = options;

  if (handles.length === 0) return { ...EMPTY_IMPORT_OUTCOME };

  const outOfRangeSamples: { handle: string; followerCount: number; status: string }[] = [];
  const unknownSizeSamples: { handle: string; followerCount: number }[] = [];
  const cacheOnly: CacheOnlyEntry[] = [];
  const measured: MeasuredHandle[] = [];
  // Per batch: handles whose save has been attempted but not yet confirmed.
  const pending: MeasuredHandle[] = [];
  const scrapedHandles: string[] = [];
  const errors: string[] = [];
  let attempted = 0;
  let saved = 0;
  let failed = 0;
  let inRange = 0;
  let outOfRangeHigh = 0;
  let outOfRangeLow = 0;
  let unknownSize = 0;
  let cancelled = false;
  let timedOut = false;

  for (const batch of chunk(handles, batchSize)) {
    // Before the scrape, not after: the cost being avoided is a billable Apify
    // run, so the check has to precede the call that starts one.
    if (signal?.aborted) {
      cancelled = true;
      break;
    }

    // Same position and the same reason. Cancellation is tested first so an
    // explicit Stop is never reported as a timeout.
    if (deadlineAt !== undefined && now() >= deadlineAt) {
      timedOut = true;
      break;
    }

    let rawProfiles: unknown[];
    try {
      rawProfiles = await scrapeBatch(batch);
    } catch (err) {
      // An abort surfaces here as a thrown AbortError. Treat it as a
      // cancellation and stop, rather than recording a failure and starting
      // the next batch — continuing is precisely the billing this guards.
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      errors.push(err instanceof Error ? err.message : 'Unknown scrape error');
      failed += batch.length;
      attempted += batch.length;
      onProgress?.(attempted, handles.length);
      continue;
    }

    attempted += batch.length;
    // Recorded only once the scrape has returned, so a batch that threw is not
    // counted as having covered its handles.
    for (const handle of batch) scrapedHandles.push(norm(handle));

    const creators: ImportableCreator[] = [];

    for (const profile of rawProfiles) {
      const mapped: MappedProfile = platform === 'tiktok'
        ? mapTikTokProfile(profile)
        : mapProfileToCreator(profile as InstagramProfile);
      const handle = norm(mapped.handle);
      if (!handle) continue;

      const importStatus = importStatusFor(mapped.followerCount, range);
      if (importStatus === 'out_of_range_high') outOfRangeHigh++;
      else if (importStatus === 'out_of_range_low') outOfRangeLow++;
      else if (importStatus === 'unknown_size') unknownSize++;
      else inRange++;

      // Cap per direction, not overall: a shared cap would let a brand tagging
      // a dozen mega-accounts crowd the small ones out of the sample entirely,
      // and the below-min accounts are the ones worth eyeballing for promotion.
      // Unmeasured handles get their own bucket for the same reason one step
      // further out — on a rough pool they would swamp both directions.
      if (importStatus === 'unknown_size') {
        if (unknownSizeSamples.length < UNKNOWN_SIZE_SAMPLE_CAP) {
          unknownSizeSamples.push({ handle, followerCount: mapped.followerCount });
        }
      } else if (importStatus !== 'active') {
        const sameDirection = outOfRangeSamples.filter(s => s.status === importStatus).length;
        if (sameDirection < SAMPLES_PER_DIRECTION) {
          outOfRangeSamples.push({
            handle, followerCount: mapped.followerCount, status: importStatus,
          });
        }
      }

      // Routing. A cache-only handle is still counted and still sampled above —
      // it was observed — but no creator record is written for it.
      const decision = policy(mapped, importStatus);

      if (decision === 'cache_only') {
        cacheOnly.push({ handle, platform, followerCount: mapped.followerCount });
        measured.push({
          handle, platform, followerCount: mapped.followerCount,
          status: importStatus, decision, saved: false,
        });
        continue;
      }

      // Held back until saveCreators confirms it. Recording it now would be
      // recording an intention.
      pending.push({
        handle, platform, followerCount: mapped.followerCount,
        status: importStatus, decision, saved: false,
      });

      creators.push({
        handle,
        fullName: mapped.fullName,
        bio: (mapped.bio || '').slice(0, 500),
        followerCount: mapped.followerCount,
        followingCount: mapped.followingCount,
        postsCount: mapped.postsCount,
        engagementRate: mapped.engagementRate,
        isVerified: mapped.isVerified,
        isBusinessAccount: mapped.isBusinessAccount,
        categoryName: mapped.categoryName,
        profilePicUrl: mapped.profilePicUrl,
        profileUrl: mapped.profileUrl,
        website: mapped.website,
        platformData: mapped.platformData,
        discoveredViaHashtags,
        importStatus,
      });
    }

    // Saved per batch rather than once at the end, so a run that is cancelled
    // or times out keeps every profile it already paid to scrape.
    const result = await saveCreators(creators, platform);
    saved += result.saved;
    failed += result.failed;
    errors.push(...result.errors);

    // Reconcile intent against what was actually written. savedHandles is the
    // list saveDiscoveredCreators confirmed; anything absent from it failed and
    // must not be reported as imported.
    const confirmed = new Set(result.savedHandles.map(h => norm(h)));
    for (const entry of pending) {
      measured.push({ ...entry, saved: confirmed.has(entry.handle) });
    }
    pending.length = 0;

    onProgress?.(attempted, handles.length);
  }

  return {
    attempted,
    saved,
    failed,
    inRange,
    outOfRangeHigh,
    outOfRangeLow,
    unknownSize,
    outOfRangeSamples,
    unknownSizeSamples,
    cacheOnly,
    measured,
    scrapedHandles,
    errors: errors.slice(0, 5),
    cancelled,
    timedOut,
  };
}

