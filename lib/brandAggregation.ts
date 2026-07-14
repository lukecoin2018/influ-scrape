import { supabase } from './supabase';
import { detectBrandsInPost } from './brandDetection';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface StoredPostForBrandAgg {
  id: string;
  caption: string | null;
  hashtags: string[] | null;
  tagged_accounts: string[] | null;
  is_sponsored: boolean;
  sponsor_signals: string[] | null;
  detected_brands: string[] | null;
  post_type: string | null;
}

export interface CumulativeBrandFields {
  detectedBrands: string[];
  sponsoredPostCount: number;
  brandPartnershipCount: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Re-runs brand detection on a stored post using the shared detectBrandsInPost().
 * ownerUsername isn't stored per-post, so owner-handle exclusion is best-effort.
 */
function redetectFromStoredPost(post: StoredPostForBrandAgg) {
  return detectBrandsInPost({
    ownerUsername: '',
    caption: post.caption || '',
    hashtags: post.hashtags || [],
    taggedAccounts: post.tagged_accounts || [],
    url: '',
    type: post.post_type || 'unknown',
  });
}

/**
 * Recomputes cumulative brand/sponsorship fields across a creator's stored posts.
 * Shared by app/api/enrich/reprocess-brands and app/api/enrich/process so both
 * paths detect brands identically.
 *
 * When persistPostUpdates is true, any post whose is_sponsored/detected_brands
 * would change is written back to creator_posts — keeping older rows in sync
 * with the current detection logic.
 */
export async function recalculateCumulativeBrandFields(
  posts: StoredPostForBrandAgg[],
  options: { persistPostUpdates: boolean }
): Promise<CumulativeBrandFields> {
  const allBrands = new Set<string>();
  let sponsoredCount = 0;

  for (const post of posts) {
    const detection = redetectFromStoredPost(post);

    if (detection.isSponsoredContent) {
      sponsoredCount++;
      detection.brandHandles.forEach(b => allBrands.add(b));
    }

    if (options.persistPostUpdates) {
      const sponsoredChanged = post.is_sponsored !== detection.isSponsoredContent;
      const brandsChanged = JSON.stringify((post.detected_brands || []).slice().sort()) !==
        JSON.stringify(detection.brandHandles.slice().sort());

      if (sponsoredChanged || brandsChanged) {
        const { error } = await supabase
          .from('creator_posts')
          .update({
            is_sponsored: detection.isSponsoredContent,
            sponsor_signals: detection.detectionSignals,
            detected_brands: detection.brandHandles,
          })
          .eq('id', post.id);

        if (error) {
          console.error(`Failed to update post ${post.id}:`, error.message);
        }
      }
    }
  }

  return {
    detectedBrands: Array.from(allBrands),
    sponsoredPostCount: sponsoredCount,
    brandPartnershipCount: allBrands.size,
  };
}
