import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

interface SaveDiscoveryRunRequest {
  hashtags: string[];
  resultsPerHashtag: number;
  minFollowers: number;
  maxFollowers: number;
  totalPostsFound: number;
  uniqueHandlesFound: number;
  profilesScraped: number;
  creatorsInRange: number;
  mode?: string;
  nicheKeywords?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: SaveDiscoveryRunRequest = await request.json();

    const { error } = await supabase.from('discovery_runs').insert({
      hashtags: body.hashtags,
      results_per_hashtag: body.resultsPerHashtag,
      min_followers: body.minFollowers,
      max_followers: body.maxFollowers,
      total_posts_found: body.totalPostsFound,
      unique_handles_found: body.uniqueHandlesFound,
      profiles_scraped: body.profilesScraped,
      creators_in_range: body.creatorsInRange,
      discovery_mode: body.mode || 'niche',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      status: 'completed',
      new_creators_added: 0,
      existing_creators_updated: 0,
    });

    if (error) {
      console.error('Error saving discovery run:', error);
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error saving discovery run:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to save discovery run' },
      { status: 500 }
    );
  }
}