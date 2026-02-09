import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import type { DetectedBrand } from '@/lib/types';

interface SaveBrandsRequest {
  brands: DetectedBrand[];
}

export async function POST(request: NextRequest) {
  try {
    const body: SaveBrandsRequest = await request.json();
    const { brands } = body;

    let newCount = 0;
    let updatedCount = 0;

    for (const brand of brands) {
      const { data, error } = await supabase.rpc('upsert_brand', {
        p_instagram_handle: brand.handle,
        p_brand_name: brand.brandName,
        p_bio: brand.bio,
        p_follower_count: brand.followerCount,
        p_following_count: brand.followingCount,
        p_is_verified: brand.isVerified,
        p_category_name: brand.categoryName,
        p_website: brand.website,
        p_profile_pic_url: brand.profilePicUrl,
        p_profile_url: brand.profileUrl,
      });

      if (error) {
        console.error('Error upserting brand:', error);
        continue;
      }

      if (data?.action === 'inserted') {
        newCount++;
      } else if (data?.action === 'updated') {
        updatedCount++;
      }
    }

    return NextResponse.json({
      saved: brands.length,
      new: newCount,
      updated: updatedCount,
    });
  } catch (error: any) {
    console.error('Error saving brands:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to save brands' },
      { status: 500 }
    );
  }
}