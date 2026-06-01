import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface LocationResult {
  country: string | null;
  city: string | null;
  confidence: number;
}

async function extractLocationFromSummary(summary: string): Promise<LocationResult> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Extract country and city from this influencer summary. Return only JSON: {country, city, confidence}. Use full English country names. Confidence 0.9+ = explicitly stated, 0.7-0.9 = strongly implied, below 0.7 set to null.\n\n${summary}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.content[0].text.trim();

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response');

  return JSON.parse(jsonMatch[0]) as LocationResult;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get('dryRun') === 'true';
  const limit = parseInt(searchParams.get('limit') || '20', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  const { data: profiles, error } = await supabase
    .from('social_profiles')
    .select('id, handle, platform, ai_summary, creator_id')
    .is('detected_country', null)
    .not('ai_summary', 'is', null)
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ updated: 0, skipped: 0, failed: 0, total: 0, byCountry: {} });
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const byCountry: Record<string, number> = {};
  const batchSize = 5;

  for (let i = 0; i < profiles.length; i += batchSize) {
    const batch = profiles.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (profile) => {
        try {
          const result = await extractLocationFromSummary(profile.ai_summary as string);

          if (result.confidence < 0.7 || !result.country) {
            skipped++;
            return;
          }

          if (!dryRun) {
            await supabase
              .from('social_profiles')
              .update({
                detected_country: result.country,
                detected_city: result.city || null,
              })
              .eq('id', profile.id);

            if (profile.creator_id) {
              await supabase
                .from('creators')
                .update({
                  country: result.country,
                  city: result.city || null,
                })
                .eq('id', profile.creator_id);
            }
          }

          updated++;
          byCountry[result.country] = (byCountry[result.country] || 0) + 1;
        } catch {
          failed++;
        }
      })
    );

    // 1.5s delay between batches (skip after last batch)
    if (i + batchSize < profiles.length) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  return NextResponse.json({
    updated,
    skipped,
    failed,
    total: profiles.length,
    byCountry,
    dryRun,
  });
}
