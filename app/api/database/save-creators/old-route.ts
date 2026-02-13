import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  try {
    // Check payload size before parsing
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 4000000) {
      return NextResponse.json(
        { error: 'Payload too large. Send fewer creators per batch.' },
        { status: 413 }
      );
    }

    const body = await request.json();
    const { creators } = body;

    if (!creators || !Array.isArray(creators) || creators.length === 0) {
      return NextResponse.json(
        { error: 'No creators provided' },
        { status: 400 }
      );
    }

    let saved = 0;
    let failed = 0;
    const errors: string[] = [];

    // Save each creator individually using the upsert function
    for (const creator of creators) {
      try {
        const { data, error } = await supabase.rpc('upsert_creator', {
          p_instagram_handle: creator.handle?.toLowerCase()?.replace(/^@/, '') || '',
          p_full_name: creator.fullName || null,
          p_bio: creator.bio || null,
          p_follower_count: creator.followerCount || 0,
          p_following_count: creator.followingCount || null,
          p_posts_count: creator.postsCount || null,
          p_engagement_rate: creator.engagementRate || null,
          p_is_verified: creator.isVerified || false,
          p_is_business_account: creator.isBusinessAccount || false,
          p_category_name: creator.categoryName || null,
          p_profile_pic_url: creator.profilePicUrl || null,
          p_profile_url: creator.profileUrl || null,
          p_website: creator.website || null,
          p_hashtags: creator.discoveredViaHashtags || [],
        });

        if (error) {
          console.error(`Failed to save ${creator.handle}:`, error.message);
          errors.push(`${creator.handle}: ${error.message}`);
          failed++;
        } else {
          saved++;
        }
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
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined, // Only return first 10 errors
    });

  } catch (err: any) {
    console.error('Save creators error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
