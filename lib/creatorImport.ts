import { supabase } from './supabase';

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
}

export interface ImportResult {
  saved: number;
  failed: number;
  total: number;
  savedHandles: string[];
  errors: string[];
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

      // 5. Update total followers
      await supabase.rpc('update_creator_total_followers', { p_creator_id: creatorId });

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
