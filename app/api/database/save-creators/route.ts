import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 4000000) {
      return NextResponse.json(
        { error: 'Payload too large. Send fewer creators per batch.' },
        { status: 413 }
      );
    }

    const body = await request.json();
    const { creators, platform = 'instagram' } = body;

    if (!creators || !Array.isArray(creators) || creators.length === 0) {
      return NextResponse.json({ error: 'No creators provided' }, { status: 400 });
    }

    let saved = 0;
    let failed = 0;
    const errors: string[] = [];

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
      } catch (err: any) {
        console.error(`Error saving ${creator.handle}:`, err.message);
        errors.push(`${creator.handle}: ${err.message}`);
        failed++;
      }
    }

    return NextResponse.json({
      saved,
      failed,
      total: creators.length,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    });

  } catch (err: any) {
    console.error('Save creators error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
