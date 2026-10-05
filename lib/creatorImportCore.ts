import type { SupabaseClient } from '@supabase/supabase-js';
import { rollUpStatuses, type ImportStatus } from './followerRange';

/**
 * The creator-import loop, with the Supabase client passed in.
 *
 * lib/creatorImport.ts binds it to the service-role client; tests pass a fake
 * (lib/creatorImport.test.ts). Moved here unchanged from creatorImport.ts
 * except for two fixes, both about never leaving a profile and its creator
 * disagreeing:
 *
 *  1. A failed existing-profile lookup FAILS that creator. It used to be read
 *     as "not found", which inserted a fresh creator and handed its id to
 *     upsert_social_profile — and that function matches on (platform, handle)
 *     and sets creator_id = COALESCE(p_creator_id, existing), so the existing
 *     profile moved to the new creator and the old one was left without it.
 *     That includes the lookup finding the handle twice (live AND archive),
 *     where maybeSingle() errors rather than picking one.
 *
 *  2. If the profile write fails for a creator THIS call inserted, the creator
 *     is deleted again (by id, from the table it went into) instead of being
 *     left as an orphan with no profile. A creator that already existed is
 *     never touched. The creator_registry row the insert trigger wrote stays,
 *     as every other deleted creator's does: the registry is "every id ever
 *     issued" and no foreign key points at a creator this new.
 *
 * The database half of (1) is docs/migrations/2026-10-05-profile-creator-
 * reassign-guard.sql: a trigger that refuses to change a profile's creator_id
 * from one creator to another, whichever code path tries.
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
  /**
   * The subset of savedHandles whose (platform, handle) already existed before
   * this call, in any population. The write still happens — the profile's
   * counts, bio and picture are refreshed — but no creator row was created.
   *
   * Returned so a caller can say "already existed" rather than "saved". The
   * function has always known this (the lookup below) and was throwing the
   * fact away; the manual-add page needs it to report per handle.
   */
  existingHandles: string[];
  errors: string[];
}

type CreatorTable = 'creators' | 'creators_archive';

/** PostgREST's code for maybeSingle()/single() matching more than one row (or, for single(), none). */
const MULTIPLE_ROWS = 'PGRST116';

/**
 * Recomputes creators.import_status from the profiles beneath it.
 *
 * A creator is only out of range when EVERY profile is — someone in range on
 * TikTok but not Instagram stays eligible. Called after any write that could
 * change a profile's status, including back to 'active' when a new in-range
 * profile is added to a previously-excluded creator.
 */
export async function rollUpCreatorImportStatusWith(db: SupabaseClient, creatorId: string): Promise<ImportStatus> {
  // Reads across every population rather than just social_profiles. A creator
  // may have profiles in either table, and the roll-up has to see all of them
  // to decide correctly. Going through the union view means adding a third
  // population later does not require touching this function.
  const { data: profiles, error } = await db
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
    db.from('creators').update({ import_status: rolledUp }).eq('id', creatorId),
    db.from('creators_archive').update({ import_status: rolledUp }).eq('id', creatorId),
  ]);

  if (main.error && archive.error) {
    console.error(`Failed to roll up import_status for ${creatorId}:`, main.error.message);
  }

  return rolledUp;
}

/**
 * Compensating step for fix (2): deletes a creator this call inserted, by its
 * own id only. Returns the note appended to the item's error line, so the
 * caller's log says what happened to the row either way.
 */
async function removeInsertedCreator(
  db: SupabaseClient,
  inserted: { table: CreatorTable; id: string },
  handle: string,
): Promise<string> {
  // Never throws: this runs inside the loop's catch too, and an escape from
  // there would abort every creator after this one.
  let data: { id: string }[] | null = null;
  let errorMessage: string | null = null;
  try {
    const result = await db.from(inserted.table).delete().eq('id', inserted.id).select('id');
    data = result.data;
    errorMessage = result.error?.message ?? null;
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  if (errorMessage || !data || data.length !== 1) {
    const why = errorMessage ?? `delete matched ${data?.length ?? 0} rows`;
    console.error(`ORPHAN LEFT: creator ${inserted.id} in ${inserted.table} for ${handle} has no profile; removing it failed: ${why}`);
    return ` (orphan left: creator ${inserted.id} in ${inserted.table}; removing it failed: ${why})`;
  }
  console.error(`Removed creator ${inserted.id} from ${inserted.table}: its profile for ${handle} was not written`);
  return ` (creator ${inserted.id} removed again from ${inserted.table})`;
}

export async function saveDiscoveredCreatorsWith(
  db: SupabaseClient,
  creators: ImportableCreator[],
  platform: string = 'instagram'
): Promise<ImportResult> {
  let saved = 0;
  let failed = 0;
  const errors: string[] = [];
  const savedHandles: string[] = [];
  const existingHandles: string[] = [];

  for (const creator of creators) {
    // Set once this call has inserted a creator row and cleared once the
    // profile is written; whatever fails in between deletes it again.
    let inserted: { table: CreatorTable; id: string } | null = null;
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

      // Only a MEASURED out-of-range verdict archives. 'unknown_size' means the
      // follower count has not been read yet, so it stays in the live tables:
      // nothing in the app reads the archive, and enrichment — which re-scrapes
      // follower_count from social_profiles — is the path that resolves it.
      // Archiving an unmeasured handle would make it permanently unmeasurable.
      const archived = targetStatus === 'out_of_range_high'
        || targetStatus === 'out_of_range_low';
      const creatorTable: CreatorTable = archived ? 'creators_archive' : 'creators';
      const archiveReason = targetStatus === 'out_of_range_high' ? 'above_max' : 'below_min';

      // 1. Check if the profile already exists in ANY population. Searching
      // only social_profiles would re-create a creator that is sitting in the
      // archive, duplicating them across both tables.
      //
      // A lookup that ERRORS fails this creator. Reading it as "not found"
      // would insert a new creator and move the existing profile onto it (see
      // the header).
      const { data: existingProfile, error: lookupError } = await db
        .from('v_social_profiles_all')
        .select('creator_id, population')
        .eq('platform', platform)
        .eq('handle', handle)
        .maybeSingle();

      if (lookupError) {
        const why = lookupError.code === MULTIPLE_ROWS
          ? `profile lookup found ${platform}:${handle} more than once (in both social_profiles and social_profiles_archive?); refusing to import it`
          : `profile lookup failed (${lookupError.message}); refusing to treat it as a new handle`;
        console.error(`Not importing ${handle}: ${why}`);
        errors.push(`${handle}: ${why}`);
        failed++;
        continue;
      }

      let creatorId: string;
      const existed = !!existingProfile;

      if (existingProfile) {
        creatorId = existingProfile.creator_id;
      } else {
        // 2. Create new creator (person) row, in the right table first time.
        const { data: newCreator, error: creatorError } = await db
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
        inserted = { table: creatorTable, id: newCreator.id };
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
        ? (await db
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
        : (await db.rpc('upsert_social_profile', {
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
        const note = inserted ? await removeInsertedCreator(db, inserted, handle) : '';
        inserted = null;
        errors.push(`${handle}: ${profileError.message}${note}`);
        failed++;
        continue;
      }
      // The profile exists now, so the creator is no longer an orphan risk.
      inserted = null;

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
      //
      // 'unknown_size' also lands here rather than on the archive path above,
      // so it is stamped in place. Promotion out of it is a plain UPDATE on
      // this same row — no cross-table move, and therefore none of the
      // duplication hazard that the archive promotion path carries.
      // Archived profiles already carry their status and stamp from the insert
      // above; only the active path needs the follow-up UPDATE.
      if (!archived && creator.importStatus !== undefined) {
        const stamped = creator.importStatus !== 'active';

        const { error: statusError } = await db
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
      await db.rpc('update_creator_total_followers', { p_creator_id: creatorId });
      await rollUpCreatorImportStatusWith(db, creatorId);

      saved++;
      savedHandles.push(handle);
      if (existed) existingHandles.push(handle);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error saving ${creator.handle}:`, message);
      // Thrown between the creator insert and the profile write: same orphan
      // risk as a returned error, same compensating delete.
      const note = inserted ? await removeInsertedCreator(db, inserted, creator.handle) : '';
      errors.push(`${creator.handle}: ${message}${note}`);
      failed++;
    }
  }

  return { saved, failed, total: creators.length, savedHandles, existingHandles, errors };
}
