import { mapProfileToCreator, mapTikTokProfile } from './apify';
import { importStatusFor, type FollowerRange } from './followerRange';
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

/** Out-of-range examples surfaced per direction. */
export const SAMPLES_PER_DIRECTION = 12;

export interface ImportOutcome {
  attempted: number;
  saved: number;
  failed: number;
  inRange: number;
  outOfRangeHigh: number;
  outOfRangeLow: number;
  /** Followers not measured — a failed or private scrape, not a small account. */
  unknownSize: number;
  outOfRangeSamples: { handle: string; followerCount: number; status: string }[];
  errors: string[];
  /** True when a batch was skipped because the signal aborted. */
  cancelled: boolean;
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
   * rows.
   */
  saveCreators: (creators: ImportableCreator[], platform: string) => Promise<ImportResult>;
}

/**
 * The subset of a mapped profile this module reads.
 *
 * Both mappers satisfy it structurally. The Instagram mapper returns
 * isBusinessAccount and categoryName; the TikTok one returns platformData and
 * omits the other two, since TikTok exposes neither.
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
  unknownSize: 0, outOfRangeSamples: [], errors: [], cancelled: false,
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
  } = options;

  if (handles.length === 0) return { ...EMPTY_IMPORT_OUTCOME };

  const outOfRangeSamples: { handle: string; followerCount: number; status: string }[] = [];
  const errors: string[] = [];
  let attempted = 0;
  let saved = 0;
  let failed = 0;
  let inRange = 0;
  let outOfRangeHigh = 0;
  let outOfRangeLow = 0;
  let unknownSize = 0;
  let cancelled = false;

  for (const batch of chunk(handles, batchSize)) {
    // Before the scrape, not after: the cost being avoided is a billable Apify
    // run, so the check has to precede the call that starts one.
    if (signal?.aborted) {
      cancelled = true;
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
      if (importStatus !== 'active') {
        const sameDirection = outOfRangeSamples.filter(s => s.status === importStatus).length;
        if (sameDirection < SAMPLES_PER_DIRECTION) {
          outOfRangeSamples.push({
            handle, followerCount: mapped.followerCount, status: importStatus,
          });
        }
      }

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
    errors: errors.slice(0, 5),
    cancelled,
  };
}
