import {
  startProfileScraper,
  startTikTokProfileScraper,
  waitForRun,
  getDatasetItems,
} from './apify';
import { saveDiscoveredCreators } from './creatorImport';
import {
  runProfileImport,
  type ImportOutcome,
  type ProfileImportCoreOptions,
} from './profileImportCore';

export {
  SAMPLES_PER_DIRECTION,
  UNKNOWN_SIZE_SAMPLE_CAP,
  EMPTY_IMPORT_OUTCOME,
  type ImportOutcome,
  type ImportPolicy,
  type CacheOnlyEntry,
  type MeasuredHandle,
} from './profileImportCore';

/**
 * Profile-scrape a list of handles and push them through the shared creator
 * import path.
 *
 * Moved verbatim out of app/api/brand-feed/process/route.ts, where it was
 * called importNewCreators. Nothing about scraping profiles and importing the
 * results is brand-specific — brand-feed simply happened to be the first
 * caller. Hashtag and keyword discovery need exactly this, and were about to
 * grow a fourth private copy of it.
 *
 * This module binds the real Apify and database effects; everything else lives
 * in profileImportCore, which takes them as parameters.
 */

export interface ImportScrapedProfilesOptions
  extends Omit<ProfileImportCoreOptions, 'scrapeBatch' | 'saveCreators'> {
  /** Overridable for tests and for callers needing different scrape behaviour. */
  scrapeBatch?: ProfileImportCoreOptions['scrapeBatch'];
  saveCreators?: ProfileImportCoreOptions['saveCreators'];
}

/**
 * The real Apify round trip: one actor run per batch, actor chosen by platform.
 *
 * Platform-aware because the previous single-actor version was the reason every
 * server-side path in this app was Instagram-only — the TikTok profile actor
 * was reachable solely from a client component.
 */
async function defaultScrapeBatch(
  batch: string[],
  platform: 'instagram' | 'tiktok',
): Promise<unknown[]> {
  const { runId } = platform === 'tiktok'
    ? await startTikTokProfileScraper(batch)
    : await startProfileScraper(batch);

  const { datasetId } = await waitForRun(runId);
  if (!datasetId) throw new Error(`Profile scrape for ${batch.length} handles returned no dataset`);
  return getDatasetItems<unknown>(datasetId);
}

export function importScrapedProfiles(
  handles: string[],
  options: ImportScrapedProfilesOptions
): Promise<ImportOutcome> {
  return runProfileImport(handles, {
    ...options,
    scrapeBatch: options.scrapeBatch ?? (batch => defaultScrapeBatch(batch, options.platform)),
    saveCreators: options.saveCreators ?? saveDiscoveredCreators,
  });
}
