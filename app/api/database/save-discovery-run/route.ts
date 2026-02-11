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
  nicheKeywords?: string[];
}

export async function POST(request: NextRequest) {
  try {
    const body: SaveDiscoveryRunRequest = await request.json();

    const { data, error } = await supabase
      .from('discovery_runs')
      .insert({
        hashtags: body.hashtags || [],
        results_per_hashtag: body.resultsPerHashtag || 0,
        min_followers: body.minFollowers || 0,
        max_followers: body.maxFollowers || 0,
        total_posts_found: body.totalPostsFound || 0,
        unique_handles_found: body.uniqueHandlesFound || 0,
        profiles_scraped: body.profilesScraped || 0,
        creators_in_range: body.creatorsInRange || 0,
        new_creators_added: 0, // Will be updated separately if needed
        existing_creators_updated: 0, // Will be updated separately if needed
        status: 'complete',
      })
      .select()
      .single();

    if (error) {
      console.error('Save discovery run error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: data.id });

  } catch (err: any) {
    console.error('Discovery run save error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
