import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(0)}K`;
  return num.toString();
}

async function buildEmbeddingText(creatorId: string): Promise<string> {
  const { data: creator } = await supabase
    .from('creators')
    .select('display_name, content_tags')
    .eq('id', creatorId)
    .single();

  const { data: profiles } = await supabase
    .from('social_profiles')
    .select('platform, handle, bio, follower_count, engagement_rate, platform_data, enrichment_data, ai_summary, detected_language, detected_country, detected_city')
    .eq('creator_id', creatorId);

  const parts: string[] = [];
  const name = creator?.display_name || 'Unknown creator';

  parts.push(`${name}.`);

  for (const profile of profiles || []) {
    parts.push(`${profile.platform === 'instagram' ? 'Instagram' : 'TikTok'} creator @${profile.handle}.`);

    if (profile.bio) {
      parts.push(`Bio: ${profile.bio.slice(0, 300)}.`);
    }

    if (profile.follower_count) {
      parts.push(`${formatNumber(profile.follower_count)} followers.`);
    }

    if (profile.engagement_rate) {
      parts.push(`${profile.engagement_rate}% engagement rate.`);
    }

    const category = profile.platform_data?.category_name;
    if (category && category !== 'null' && !String(category).startsWith('None')) {
      parts.push(`Category: ${category}.`);
    }

    // --- Intelligence layer data ---
    if (profile.detected_language) {
      parts.push(`Primary language: ${profile.detected_language}.`);
    }
    if (profile.detected_country) {
      parts.push(`Location: ${profile.detected_city ? `${profile.detected_city}, ` : ''}${profile.detected_country}.`);
    }
    if (profile.ai_summary) {
      parts.push(`About: ${profile.ai_summary}`);
    }
    // --- End intelligence layer ---

    const enrichment = profile.enrichment_data;
    if (enrichment && Object.keys(enrichment).length > 0) {
      if (enrichment.posting_frequency_per_week) {
        parts.push(`Posts ${enrichment.posting_frequency_per_week} times per week.`);
      }

      if (enrichment.content_mix) {
        const mixParts = Object.entries(enrichment.content_mix)
          .filter(([_, pct]) => (pct as number) > 0)
          .map(([type, pct]) => {
            const friendlyType = type === 'Sidecar' ? 'carousel' : type.toLowerCase();
            return `${pct}% ${friendlyType}`;
          });
        if (mixParts.length > 0) {
          parts.push(`Content mix: ${mixParts.join(', ')}.`);
        }
      }

      if (enrichment.top_hashtags?.length > 0) {
        parts.push(`Topics and hashtags: ${enrichment.top_hashtags.join(', ')}.`);
      }

      if (enrichment.detected_brands?.length > 0) {
        parts.push(`Has worked with brands: ${enrichment.detected_brands.join(', ')}.`);
      }

      if (enrichment.sponsored_posts_count > 0) {
        parts.push(`${enrichment.sponsored_posts_count} sponsored posts detected.`);
      }

      if (enrichment.days_since_last_post !== undefined && enrichment.days_since_last_post !== null) {
        if (enrichment.days_since_last_post <= 7) {
          parts.push('Very active, posted within the last week.');
        } else if (enrichment.days_since_last_post <= 30) {
          parts.push('Moderately active, posted within the last month.');
        } else {
          parts.push(`Inactive, last posted ${enrichment.days_since_last_post} days ago.`);
        }
      }
    }
  }

  if (creator?.content_tags?.length > 0) {
    parts.push(`Tagged as: ${creator?.content_tags?.join(', ')}.`);
  }

  return parts.join(' ');
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

async function saveEmbedding(
  creatorId: string,
  embedding: number[],
  embeddingText: string
) {
  const vectorString = `[${embedding.join(',')}]`;

  const { error } = await supabase
    .from('creators')
    .update({
      embedding: vectorString,
      embedding_text: embeddingText,
      embedded_at: new Date().toISOString(),
    })
    .eq('id', creatorId);

  if (error) throw error;
}

export async function POST(request: NextRequest) {
  try {
    const { mode, batchSize = 50, handles = [] } = await request.json();

    let creatorIds: { id: string; handle: string }[] = [];

    if (mode === 'specific') {
      const cleanHandles = handles.map((h: string) =>
        h.trim().toLowerCase().replace(/^@/, '')
      ).filter(Boolean);

      const { data: profiles } = await supabase
        .from('social_profiles')
        .select('creator_id, handle')
        .in('handle', cleanHandles);

      const seen = new Set<string>();
      for (const p of profiles || []) {
        if (!seen.has(p.creator_id)) {
          seen.add(p.creator_id);
          creatorIds.push({ id: p.creator_id, handle: p.handle });
        }
      }
    } else if (mode === 'has_ai_summary') {
      // Re-embed creators that have an AI summary — these get much richer embeddings
      const { data: profiles } = await supabase
        .from('social_profiles')
        .select('creator_id, handle')
        .not('ai_summary', 'is', null);

      const seen = new Set<string>();
      const creatorHandles = new Map<string, string>();
      for (const p of profiles || []) {
        if (!seen.has(p.creator_id)) {
          seen.add(p.creator_id);
          creatorHandles.set(p.creator_id, p.handle);
        }
      }

      // Get the creator records, ordered by followers for quality-first processing
      const ids = [...seen];
      // Process in batches of batchSize
      const { data: creators } = await supabase
        .from('creators')
        .select('id, display_name')
        .in('id', ids)
        .order('total_followers', { ascending: false })
        .limit(batchSize);

      for (const c of creators || []) {
        creatorIds.push({ id: c.id, handle: creatorHandles.get(c.id) || c.display_name || c.id });
      }
    } else if (mode === 'enriched_first') {
      const { data: enrichedProfiles } = await supabase
        .from('social_profiles')
        .select('creator_id, handle')
        .not('enriched_at', 'is', null);

      const enrichedIds = new Set(
        (enrichedProfiles || []).map((p: any) => p.creator_id)
      );

      const { data: creators } = await supabase
        .from('creators')
        .select('id, display_name')
        .is('embedded_at', null)
        .limit(batchSize * 2);

      const enriched = (creators || []).filter(c => enrichedIds.has(c.id));
      const notEnriched = (creators || []).filter(c => !enrichedIds.has(c.id));
      const ordered = [...enriched, ...notEnriched].slice(0, batchSize);

      for (const c of ordered) {
        const profile = (enrichedProfiles || []).find((p: any) => p.creator_id === c.id);
        creatorIds.push({ id: c.id, handle: profile?.handle || c.display_name || c.id });
      }
    } else if (mode === 're_embed') {
      const { data: creators } = await supabase
        .from('creators')
        .select('id, display_name')
        .order('total_followers', { ascending: false })
        .limit(batchSize);

      for (const c of creators || []) {
        creatorIds.push({ id: c.id, handle: c.display_name || c.id });
      }
    } else {
      // not_embedded (default)
      const { data: creators } = await supabase
        .from('creators')
        .select('id, display_name')
        .is('embedded_at', null)
        .order('total_followers', { ascending: false })
        .limit(batchSize);

      for (const c of creators || []) {
        creatorIds.push({ id: c.id, handle: c.display_name || c.id });
      }
    }

    const results = [];

    for (const creator of creatorIds) {
      try {
        const text = await buildEmbeddingText(creator.id);

        if (text.length < 50) {
          results.push({ handle: creator.handle, status: 'skipped', reason: 'insufficient data' });
          continue;
        }

        const embedding = await generateEmbedding(text);
        await saveEmbedding(creator.id, embedding, text);

        results.push({
          handle: creator.handle,
          status: 'success',
          textLength: text.length,
        });
      } catch (err: any) {
        console.error(`Failed to embed ${creator.handle}:`, err.message);
        results.push({ handle: creator.handle, status: 'error', reason: err.message });
      }
    }

    const succeeded = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;
    const skipped = results.filter(r => r.status === 'skipped').length;

    return NextResponse.json({ results, succeeded, failed, skipped });
  } catch (error: any) {
    console.error('Embeddings generate error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to generate embeddings' },
      { status: 500 }
    );
  }
}
