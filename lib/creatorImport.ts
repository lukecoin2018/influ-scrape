import { supabase } from './supabase';
import { rollUpStatuses, type ImportStatus } from './followerRange';

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
  // Reads across every population rather than just social_profiles. A creator
  // may have profiles in either table, and the roll-up has to see all of them
  // to decide correctly. Going through the union view means adding a third
  // population later does not require touching this function.
  const { data: profiles, error } = await supabase
    .from('v_social_profiles_all')
    .select('import_status')
    .eq('creator_id', creatorId);

  if (error) {
    console.error(`Failed to read profiles for roll-up of ${creatorId}:`, error.message);
    return 'active';
  }

  const rolledUp = rollUpStatuses(
    (profiles || []).map(p => p.import_status as ImportStatus)
  );

  // The creator row lives in whichever table its population dictates. Update
  // both by id: exactly one will match, and neither needs this function to
  // know which. That keeps it population-agnostic.
  const [main, archive] = await Promise.all([
    supabase.from('creators').update({ import_status: rolledUp }).eq('id', creatorId),
    supabase.from('creators_archive').update({ import_status: rolledUp }).eq('id', creatorId),
  ]);

  if (main.error && archive.error) {
    console.error(`Failed to roll up import_status for ${creatorId}:`, main.error.message);
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

      // Where this creator belongs. Decided BEFORE anything is written, so an
      // out-of-range creator is never inserted into the main tables and then
      // moved — the archive is their first and only destination.
      const targetStatus: ImportStatus = creator.importStatus ?? 'active';
      const archived = targetStatus !== 'active';
      const creatorTable = archived ? 'creators_archive' : 'creators';
      const archiveReason = targetStatus === 'out_of_range_high' ? 'above_max' : 'below_min';

      // 1. Check if the profile already exists in ANY population. Searching
      // only social_profiles would re-create a creator that is sitting in the
      // archive, duplicating them across both tables.
      const { data: existingProfile } = await supabase
        .from('v_social_profiles_all')
        .select('creator_id, population')
        .eq('platform', platform)
        .eq('handle', handle)
        .maybeSingle();

      let creatorId: string;

      if (existingProfile) {
        creatorId = existingProfile.creator_id;
      } else {
        // 2. Create new creator (person) row, in the right table first time.
        const { data: newCreator, error: creatorError } = await supabase
          .from(creatorTable)
          .insert({
            display_name: creator.fullName || handle,
            full_name: creator.fullName || null,
            primary_platform: platform,
            status: 'active',
            import_status: targetStatus,
            ...(archived ? { archive_reason: archiveReason } : {}),
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

      // 4. Write the social profile.
      //
      // The archive path cannot use upsert_social_profile: that RPC has a fixed
      // signature and writes to social_profiles by definition. Archived
      // profiles are inserted directly, carrying their stamp columns in the
      // same statement rather than as a follow-up UPDATE.
      const stampedNow = new Date().toISOString();

      const profileError = archived
        ? (await supabase
            .from('social_profiles_archive')
            .upsert({
              creator_id: creatorId,
              platform,
              handle,
              follower_count: creator.followerCount || 0,
              following_count: creator.followingCount ?? null,
              posts_count: creator.postsCount ?? null,
              engagement_rate: creator.engagementRate ?? null,
              is_verified: creator.isVerified || false,
              profile_pic_url: creator.profilePicUrl || null,
              profile_url: creator.profileUrl || null,
              bio: creator.bio || null,
              website: creator.website || null,
              platform_data: creator.platformData || (platform === 'instagram'
                ? {
                    is_business_account: creator.isBusinessAccount || false,
                    category_name: creator.categoryName || null,
                  }
                : {}),
              discovered_via_hashtags: creator.discoveredViaHashtags || [],
              import_status: targetStatus,
              import_status_at: stampedNow,
              import_status_follower_count: creator.followerCount ?? null,
              archive_reason: archiveReason,
            }, { onConflict: 'platform,handle' })
          ).error
        : (await supabase.rpc('upsert_social_profile', {
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
      })).error;

      if (profileError) {
        console.error(`Failed to upsert social profile for ${handle}:`, profileError.message);
        errors.push(`${handle}: ${profileError.message}`);
        failed++;
        continue;
      }

      // 5. Apply import_status and its stamp provenance.
      //
      // upsert_social_profile's signature is fixed and shared with hashtag
      // discovery and manual add, so these are written as a follow-up UPDATE
      // rather than by changing that function.
      //
      // The guard is `!== undefined`, not `!== 'active'`: callers that never
      // pass importStatus (hashtag discovery, manual add, dataset import) are
      // still untouched, but a caller that explicitly says 'active' can now
      // promote a previously-stamped profile back. Without that, a profile
      // stamped out_of_range_low could never return to the pipelines by
      // being re-discovered in range.
      // Archived profiles already carry their status and stamp from the insert
      // above; only the active path needs the follow-up UPDATE.
      if (!archived && creator.importStatus !== undefined) {
        const stamped = creator.importStatus !== 'active';

        const { error: statusError } = await supabase
          .from('social_profiles')
          .update({
            import_status: creator.importStatus,
            // Snapshot what the decision was based on. Cleared on promotion so
            // a stale snapshot can never outlive the stamp it belonged to.
            import_status_at: stamped ? new Date().toISOString() : null,
            import_status_follower_count: stamped ? (creator.followerCount ?? null) : null,
          })
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
