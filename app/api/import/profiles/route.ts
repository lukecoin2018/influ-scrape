import { NextRequest, NextResponse } from 'next/server';
import { getDatasetItems } from '@/lib/apify';
import { supabase } from '@/lib/supabase';

interface ImportRequest {
  datasetIds: string[];
  minFollowers: number;
  maxFollowers: number;
}

export async function POST(request: NextRequest) {
  try {
    const body: ImportRequest = await request.json();
    const { datasetIds, minFollowers, maxFollowers } = body;

    // Fetch all profiles from all datasets
    let allProfiles: any[] = [];
    
    for (const datasetId of datasetIds) {
      try {
        const items = await getDatasetItems(datasetId);
        allProfiles = allProfiles.concat(items);
      } catch (error) {
        console.error(`Error fetching dataset ${datasetId}:`, error);
      }
    }

    // Deduplicate by username
    const uniqueProfiles = Array.from(
      new Map(allProfiles.map(p => [p.username || p.profileName, p])).values()
    );

    // Filter by follower range
    const filteredProfiles = uniqueProfiles.filter(profile => {
      const followers = profile.followersCount || 0;
      return followers >= minFollowers && followers <= maxFollowers;
    });

    // Convert to creator format
    const creators = filteredProfiles.map(profile => ({
      handle: profile.username || profile.profileName,
      fullName: profile.fullName || profile.username,
      bio: profile.biography || '',
      followerCount: profile.followersCount || 0,
      followingCount: profile.followsCount || 0,
      postsCount: profile.postsCount || 0,
      engagementRate: 0, // Calculate if needed
      isVerified: profile.verified || false,
      categoryName: profile.category || null,
      profilePicUrl: profile.profilePicUrl || null,
      profileUrl: `https://instagram.com/${profile.username || profile.profileName}`,
    }));

    // Save to database in batches
    const creatorBatchSize = 20;
    let newCount = 0;
    let updatedCount = 0;

    for (let i = 0; i < creators.length; i += creatorBatchSize) {
      const batch = creators.slice(i, i + creatorBatchSize);
      
      const saveResponse = await fetch(`${request.nextUrl.origin}/api/database/save-creators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creators: batch,
          runMetadata: i === 0 ? {
            hashtags: ['imported'],
            resultsPerHashtag: 0,
            minFollowers,
            maxFollowers,
            totalPostsFound: 0,
            uniqueHandlesFound: creators.length,
            profilesScraped: allProfiles.length,
            creatorsInRange: creators.length,
          } : undefined,
        }),
      });

      const saveResult = await saveResponse.json();
      newCount += saveResult.new || 0;
      updatedCount += saveResult.updated || 0;
    }

    return NextResponse.json({
      totalFetched: allProfiles.length,
      uniqueProfiles: uniqueProfiles.length,
      inRange: filteredProfiles.length,
      saved: creators.length,
      new: newCount,
      updated: updatedCount,
    });
  } catch (error: any) {
    console.error('Import error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to import profiles' },
      { status: 500 }
    );
  }
}