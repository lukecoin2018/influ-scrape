import {
  startProfileScraper,
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
} from './profileImportCore';

/**
 * Profile-scrape a list of handles and push them through the shared creator
 * import path.
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

/** The real Apify round trip: one actor run per batch. */
async function defaultScrapeBatch(batch: string[]): Promise<unknown[]> {
  const { runId } = await startProfileScraper(batch);
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
    scrapeBatch: options.scrapeBatch ?? defaultScrapeBatch,
    saveCreators: options.saveCreators ?? saveDiscoveredCreators,
  });
}
