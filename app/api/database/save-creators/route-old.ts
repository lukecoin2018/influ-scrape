import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import type { DiscoveredCreator } from '@/lib/types';

interface SaveCreatorsRequest {
  creators: DiscoveredCreator[];
  runMetadata: {
    hashtags: string[];
    resultsPerHashtag: number;
    minFollowers: number;
    maxFollowers: number;
    totalPostsFound: number;
    uniqueHandlesFound: number;
    profilesScraped: number;
    creatorsInRange: number;
  };
}

export async function POST(request: NextRequest) {
  try {
    const body: SaveCreatorsRequest = await request.json();
    const { creators, runMetadata } = body;

    let newCount = 0;
    let updatedCount = 0;

    // Upsert each creator
    for (const creator of creators) {
      const { data, error } = await supabase.rpc('upsert_creator', {
        p_instagram_handle: creator.handle,
        p_full_name: creator.fullName,
        p_bio: creator.bio,
        p_follower_count: creator.followerCount,
        p_following_count: creator.followingCount,
        p_posts_count: creator.postsCount,
        p_engagement_rate: creator.engagementRate,
        p_is_verified: creator.isVerified,
        p_is_business_account: creator.isBusinessAccount,
        p_category_name: creator.categoryName,
        p_profile_pic_url: creator.profilePicUrl,
        p_profile_url: creator.profileUrl,
        p_website: creator.website,
        p_hashtags: runMetadata.hashtags,
      });

      if (error) {
        console.error('Error upserting creator:', error);
        continue;
      }

      if (data?.action === 'inserted') {
        newCount++;
      } else if (data?.action === 'updated') {
        updatedCount++;
      }
    }

    // Log the discovery run
    const { error: runError } = await supabase.from('discovery_runs').insert({
      hashtags: runMetadata.hashtags,
      results_per_hashtag: runMetadata.resultsPerHashtag,
      min_followers: runMetadata.minFollowers,
      max_followers: runMetadata.maxFollowers,
      total_posts_found: runMetadata.totalPostsFound,
      unique_handles_found: runMetadata.uniqueHandlesFound,
      profiles_scraped: runMetadata.profilesScraped,
      creators_in_range: runMetadata.creatorsInRange,
      new_creators_added: newCount,
      existing_creators_updated: updatedCount,
      status: 'completed',
      completed_at: new Date().toISOString(),
    });

    if (runError) {
      console.error('Error logging run:', runError);
    }

    return NextResponse.json({
      saved: creators.length,
      new: newCount,
      updated: updatedCount,
    });
  } catch (error: any) {
    console.error('Error saving creators:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to save creators' },
      { status: 500 }
    );
  }
}