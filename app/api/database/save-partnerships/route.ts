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
      // Look up creator_id across ALL populations.
      //
      // Out-of-range creators live in creators_archive. Resolving against
      // creators alone would silently drop every edge belonging to an archived
      // creator — and 1,288 of 2,194 existing edges are exactly that. The edge
      // is the intelligence; losing it is the failure this whole separation is
      // designed to avoid.
      const { data: creatorData } = await supabase
        .from('v_creators_all')
        .select('id')
        .eq('instagram_handle', partnership.creatorHandle)
        .maybeSingle();

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

    // recalculate_brand_stats() is deliberately NOT called here.
    //
    // That RPC rebuilds total_partnerships_detected,
    // avg/min/max_partner_follower_count, preferred_creator_tier and
    // active_niches entirely from the partnerships table. But the enrich
    // pipeline never writes partnerships — it increments
    // brands.total_partnerships_detected in place, one creator at a time. So
    // 11,462 brands carry enrich-built counters that partnerships cannot
    // reproduce, and avg/min/max_partner_follower_count plus
    // preferred_creator_tier feed brand-bracket matching in the live platform
    // app. Running it would replace those with numbers derived from whatever
    // edges happen to exist.
    //
    // The underlying rule: a derived column has one owner that recomputes it
    // from the rows it derives from. It is never incremented in place by a
    // writer that sees only its own slice. The casting_* columns are the
    // pattern — single owner, recomputed, parameters stored alongside.
    //
    // What would make this RPC correct: partnerships being the complete
    // record of brand-creator collaborations. That means backfilling it from
    // creator_posts.detected_brands, which is blocked on the TikTok
    // truncation repair — 36% of TikTok mentions are display-name fragments
    // and would be written as brand edges. Sequenced in
    // docs/partnerships-as-source-of-truth.md. Do not restore this call until
    // that plan has been executed.

    return NextResponse.json({
      saved: savedCount,
      total: partnerships.length,
      // Reported rather than acted on: these are the brands whose statistics
      // WOULD have been recomputed, so a caller can see the blast radius the
      // removed call had.
      brandsAffected: affectedBrandIds.size,
    });
  } catch (error: any) {
    console.error('Error saving partnerships:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to save partnerships' },
      { status: 500 }
    );
  }
}