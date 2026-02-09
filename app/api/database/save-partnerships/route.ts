import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import type { Partnership } from '@/lib/types';

interface SavePartnershipsRequest {
  partnerships: Partnership[];
}

export async function POST(request: NextRequest) {
  try {
    const body: SavePartnershipsRequest = await request.json();
    const { partnerships } = body;

    let savedCount = 0;
    const affectedBrandIds = new Set<string>();

    for (const partnership of partnerships) {
      // Look up creator_id
      const { data: creatorData } = await supabase
        .from('creators')
        .select('id')
        .eq('instagram_handle', partnership.creatorHandle)
        .single();

      if (!creatorData) {
        console.log(`Creator not found: ${partnership.creatorHandle}`);
        continue;
      }

      // Look up brand_id
      const { data: brandData } = await supabase
        .from('brands')
        .select('id')
        .eq('instagram_handle', partnership.brandHandle)
        .single();

      if (!brandData) {
        console.log(`Brand not found: ${partnership.brandHandle}`);
        continue;
      }

      // Insert partnership (ON CONFLICT DO NOTHING)
      const { error } = await supabase.from('partnerships').insert({
        creator_id: creatorData.id,
        brand_id: brandData.id,
        post_url: partnership.postUrl,
        post_type: partnership.postType,
        post_caption: partnership.postCaption,
        posted_at: partnership.postedAt,
        likes_count: partnership.likesCount,
        comments_count: partnership.commentsCount,
        views_count: partnership.viewsCount,
        detection_signals: partnership.detectionSignals,
        detection_confidence: partnership.detectionConfidence,
        discovered_via_hashtag: partnership.discoveredViaHashtag,
      });

      if (!error) {
        savedCount++;
        affectedBrandIds.add(brandData.id);
      }
    }

    // Recalculate stats for affected brands
    for (const brandId of affectedBrandIds) {
      await supabase.rpc('recalculate_brand_stats', { p_brand_id: brandId });
    }

    return NextResponse.json({
      saved: savedCount,
      total: partnerships.length,
    });
  } catch (error: any) {
    console.error('Error saving partnerships:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to save partnerships' },
      { status: 500 }
    );
  }
}