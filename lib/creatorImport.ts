import { supabase } from './supabase';
import type { ImportStatus } from './followerRange';

/**
 * Shared creator-import path.
 *
 * Extracted verbatim from app/api/database/save-creators/route.ts so that
 * server-side callers can reach it directly. An internal
 * fetch('/api/database/save-creators') does NOT work from a route handler:
 * middleware.ts guards every path except /login and /api/auth/*, and a
 * server-to-server fetch carries no session cookie, so the request is
 * redirected to /login instead of executing.
 *
 * Dedupe contract (unchanged): a creator is identified by
 * (platform, handle) in social_profiles. A hit reuses the existing
 * creator_id; a miss inserts a creators row first. This is the single
 * place new handles enter the database, regardless of which discovery
 * source found them.
 */

export interface ImportableCreator {
  handle: string;
  fullName?: string;
  bio?: string;
  followerCount?: number;
  followingCount?: number;
  postsCount?: number;
  engagementRate?: number | null;
  isVerified?: boolean;
  isBusinessAccount?: boolean;
  categoryName?: string | null;
  profilePicUrl?: string;
  profileUrl?: string;
  website?: string;
  discoveredViaHashtags?: string[];
  platformData?: Record<string, unknown>;
  /**
   * Defaults to 'active' when omitted, so existing callers (hashtag
   * discovery, manual add, dataset import) are unaffected.
   */
  importStatus?: ImportStatus;
}

export interface ImportResult {
  saved: number;
  failed: number;
  total: number;
  savedHandles: string[];
  errors: string[];
}

/**
 * Recomputes creators.import_status from the profiles beneath it.
 *
 * A creator is only out of range when EVERY profile is — someone in range on
 * TikTok but not Instagram stays eligible. Called after any write that could
 * change a profile's status, including back to 'active' when a new in-range
 * profile is added to a previously-excluded creator.
 */
export async function rollUpCreatorImportStatus(creatorId: string): Promise<ImportStatus> {
  const { data: profiles, error } = await supabase
    .from('social_profiles')
    .select('import_status')
    .eq('creator_id', creatorId);

  if (error) {
    console.error(`Failed to read profiles for roll-up of ${creatorId}:`, error.message);
    return 'active';
  }

  const rows = profiles || [];
  const rolledUp: ImportStatus =
    rows.length > 0 && rows.every(p => p.import_status === 'out_of_range')
      ? 'out_of_range'
      : 'active';

  const { error: updateError } = await supabase
    .from('creators')
    .update({ import_status: rolledUp })
    .eq('id', creatorId);

  if (updateError) {
    console.error(`Failed to roll up import_status for ${creatorId}:`, updateError.message);
  }

  return rolledUp;
}

export async function saveDiscoveredCreators(
  creators: ImportableCreator[],
  platform: string = 'instagram'
): Promise<ImportResult> {
  let saved = 0;
  let failed = 0;
  const errors: string[] = [];
  const savedHandles: string[] = [];

  for (const creator of creators) {
    try {
      const handle = creator.handle?.toLowerCase()?.replace(/^@/, '') || '';
      if (!handle) {
        errors.push(`Skipped creator with no handle`);
        failed++;
        continue;
      }

      // 1. Check if social profile already exists
      const { data: existingProfile } = await supabase
        .from('social_profiles')
        .select('creator_id')
        .eq('platform', platform)
        .eq('handle', handle)
        .single();

      let creatorId: string;

      if (existingProfile) {
        creatorId = existingProfile.creator_id;
      } else {
        // 2. Create new creator (person) row
        const { data: newCreator, error: creatorError } = await supabase
          .from('creators')
          .insert({
            display_name: creator.fullName || handle,
            full_name: creator.fullName || null,
            primary_platform: platform,
            status: 'active',
          })
          .select('id')
          .single();

        if (creatorError || !newCreator) {
          console.error(`Failed to create creator row for ${handle}:`, creatorError?.message);
          errors.push(`${handle}: ${creatorError?.message}`);
          failed++;
          continue;
        }

        creatorId = newCreator.id;
      }

      // 3. Build platform-specific data
      const platformData = creator.platformData || (platform === 'instagram'
        ? {
            is_business_account: creator.isBusinessAccount || false,
            category_name: creator.categoryName || null,
          }
        : {});

      // 4. Upsert the social profile
      const { error: profileError } = await supabase.rpc('upsert_social_profile', {
        p_creator_id: creatorId,
        p_platform: platform,
        p_handle: handle,
        p_follower_count: creator.followerCount || 0,
        p_following_count: creator.followingCount || null,
        p_posts_count: creator.postsCount || null,
        p_engagement_rate: creator.engagementRate || null,
        p_is_verified: creator.isVerified || false,
        p_profile_pic_url: creator.profilePicUrl || null,
        p_profile_url: creator.profileUrl || null,
        p_bio: creator.bio || null,
        p_website: creator.website || null,
        p_platform_data: platformData,
        p_hashtags: creator.discoveredViaHashtags || [],
      });

      if (profileError) {
        console.error(`Failed to upsert social profile for ${handle}:`, profileError.message);
        errors.push(`${handle}: ${profileError.message}`);
        failed++;
        continue;
      }

      // 5. Apply import_status.
      //
      // upsert_social_profile's signature is fixed and shared with hashtag
      // discovery and manual add, so the status is written as a follow-up
      // UPDATE rather than by changing that function. Only written when the
      // caller asked for a non-default value, so the other import paths never
      // touch the column.
      if (creator.importStatus && creator.importStatus !== 'active') {
        const { error: statusError } = await supabase
          .from('social_profiles')
          .update({ import_status: creator.importStatus })
          .eq('platform', platform)
          .eq('handle', handle);

        if (statusError) {
          console.error(`Failed to set import_status for ${handle}:`, statusError.message);
        }
      }

      // 6. Update total followers and roll the status up to the creator.
      await supabase.rpc('update_creator_total_followers', { p_creator_id: creatorId });
      await rollUpCreatorImportStatus(creatorId);

      saved++;
      savedHandles.push(handle);
    } catch (err: any) {
      console.error(`Error saving ${creator.handle}:`, err.message);
      errors.push(`${creator.handle}: ${err.message}`);
      failed++;
    }
  }

  return { saved, failed, total: creators.length, savedHandles, errors };
}
