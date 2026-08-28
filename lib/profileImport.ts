import {
  startProfileScraper,
  waitForRun,
  getDatasetItems,
  mapProfileToCreator,
  mapTikTokProfile,
} from './apify';
import { saveDiscoveredCreators, type ImportableCreator } from './creatorImport';
import { importStatusFor, type FollowerRange } from './followerRange';
import { looseHandle as norm } from './handles';
import type { InstagramProfile } from './types';

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
 * Two parameters replace what were hardcoded values:
 *
 *   platform               was 'instagram' at the saveDiscoveredCreators call,
 *                          and mapProfileToCreator was the only mapper
 *   discoveredViaHashtags  was the literal ['brand_feed']
 *
 * Passing the values that were hardcoded reproduces the previous behaviour
 * exactly, which is how brand-feed is unchanged by this move.
 */

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
}

export interface ImportScrapedProfilesOptions {
  range: FollowerRange;
  platform: 'instagram' | 'tiktok';
  /** Provenance written to social_profiles.discovered_via_hashtags. */
  discoveredViaHashtags: string[];
}

/**
 * The subset of a mapped profile this module reads.
 *
 * Both mappers satisfy it structurally. The Instagram mapper returns
 * isBusinessAccount and categoryName; the TikTok one returns platformData and
 * omits the other two, since TikTok exposes neither. Declaring the union here
 * rather than widening either mapper keeps both of them untouched by this move.
 */
interface MappedProfile {
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
  unknownSize: 0, outOfRangeSamples: [], errors: [],
};

export async function importScrapedProfiles(
  handles: string[],
  options: ImportScrapedProfilesOptions
): Promise<ImportOutcome> {
  const { range, platform, discoveredViaHashtags } = options;

  if (handles.length === 0) return { ...EMPTY_IMPORT_OUTCOME };

  const { runId } = await startProfileScraper(handles);
  const { datasetId } = await waitForRun(runId);

  if (!datasetId) throw new Error(`Profile scrape for ${handles.length} handles returned no dataset`);

  const rawProfiles = await getDatasetItems<unknown>(datasetId);

  const creators: ImportableCreator[] = [];
  const outOfRangeSamples: { handle: string; followerCount: number; status: string }[] = [];
  let inRange = 0;
  let outOfRangeHigh = 0;
  let outOfRangeLow = 0;
  let unknownSize = 0;

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

  const result = await saveDiscoveredCreators(creators, platform);

  return {
    attempted: handles.length,
    saved: result.saved,
    failed: result.failed,
    inRange,
    outOfRangeHigh,
    outOfRangeLow,
    unknownSize,
    outOfRangeSamples,
    errors: result.errors.slice(0, 5),
  };
}
