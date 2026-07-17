import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import {
  canonicalCountry,
  canonicalCity,
  isPlausibleCityCountryPair,
  isValidLocationField,
} from '@/lib/location-normalization';

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
          content: `Extract country and city from this influencer summary. Return only JSON: {country, city, confidence}. Use full English country names. City must be a real city - never a state, province, or region name (e.g. "Florida", "Andalusia", "Sicily" are not cities; if only a state/region is mentioned, set city to null and keep the country). Confidence 0.9+ = explicitly stated, 0.7-0.9 = strongly implied, below 0.55 set to null.

PRIORITY RULE: an explicit residency statement ("based in X", "lives in X", "X-based creator") always determines the COUNTRY field, and must override any heritage, ethnicity, nationality-by-birth, or audience-language signal. Example: "Colombian-born creator based in Miami" -> country is United States, not Colombia. Only fall back to a language/audience signal (e.g. Italian, Portuguese-speaking, Spanish-speaking) as a WEAK signal (confidence 0.75 max) when no explicit residency city or country is stated anywhere in the summary. IMPORTANT: Portuguese-speaking does NOT mean Portugal. Brazil has 215 million Portuguese speakers. Only assign Portugal if the summary explicitly mentions Portugal, Lisbon, Porto, or Portuguese cities. If a creator speaks Portuguese without explicit Portugal mention, assign Brazil instead.

If the summary describes a creator active across multiple cities/countries with no single primary base, set city and country to null rather than guessing one.\n\n${summary}`,
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

  const parsed = JSON.parse(jsonMatch[0]);

  // Type-guard: Claude occasionally returns an array (multi-location creators)
  // instead of a single string. Treat anything else as an extraction failure
  // rather than writing a stringified array/object into a text column.
  if (!isValidLocationField(parsed.country) || !isValidLocationField(parsed.city)) {
    throw new Error(`Non-string location field in Claude response: ${jsonMatch[0]}`);
  }

  return parsed as LocationResult;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dryRun = searchParams.get('dryRun') === 'true';
  const limit = parseInt(searchParams.get('limit') || '20', 10);
  const offset = parseInt(searchParams.get('offset') || '0', 10);

  const random = searchParams.get('random') === 'true';

  let profiles;
  let error;

  if (random) {
    // Fetch a larger pool then shuffle in JS (Supabase JS client has no ORDER BY RANDOM())
    const { data, error: err } = await supabase
      .from('social_profiles')
      .select('id, handle, platform, ai_summary, creator_id')
      .is('detected_country', null)
      .not('ai_summary', 'is', null)
      .limit(500);
    error = err;
    if (data) {
      for (let i = data.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [data[i], data[j]] = [data[j], data[i]];
      }
      profiles = data.slice(0, limit);
    }
  } else {
    const { data, error: err } = await supabase
      .from('social_profiles')
      .select('id, handle, platform, ai_summary, creator_id')
      .is('detected_country', null)
      .not('ai_summary', 'is', null)
      .range(offset, offset + limit - 1);
    error = err;
    profiles = data;
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ updated: 0, skipped: 0, failed: 0, total: 0, byCountry: {} });
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let flagged = 0;
  const byCountry: Record<string, number> = {};
  const debug: Array<{ handle: string; country: string | null; city: string | null; confidence: number | null; status: 'updated' | 'skipped' | 'failed' | 'flagged_mismatch' }> = [];

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const handle = profile.handle as string;

    const tryExtract = async (): Promise<LocationResult | null> => {
      try {
        return await extractLocationFromSummary(profile.ai_summary as string);
      } catch {
        // Wait 5s and retry once
        await new Promise((resolve) => setTimeout(resolve, 5000));
        try {
          return await extractLocationFromSummary(profile.ai_summary as string);
        } catch {
          return null;
        }
      }
    };

    const result = await tryExtract();

    if (!result) {
      failed++;
      debug.push({ handle, country: null, city: null, confidence: null, status: 'failed' });
    } else if (result.confidence < 0.55 || !result.country) {
      skipped++;
      debug.push({ handle, country: result.country, city: result.city, confidence: result.confidence, status: 'skipped' });
    } else {
      const country = canonicalCountry(result.country);
      const city = canonicalCity(result.city, country);

      // Don't silently write a confident but implausible city/country pair
      // (e.g. "Miami" + a heritage country) - leave detected_country null so
      // the row is picked up again once someone/something resolves it,
      // instead of letting a heritage/audience-language signal quietly
      // clobber an explicit residency statement.
      if (!isPlausibleCityCountryPair(city, country)) {
        flagged++;
        debug.push({ handle, country, city, confidence: result.confidence, status: 'flagged_mismatch' });
      } else {
        if (!dryRun) {
          await supabase
            .from('social_profiles')
            .update({
              detected_country: country,
              detected_city: city,
            })
            .eq('id', profile.id);

          if (profile.creator_id) {
            await supabase
              .from('creators')
              .update({
                country,
                city,
              })
              .eq('id', profile.creator_id);
          }
        }

        updated++;
        if (country) byCountry[country] = (byCountry[country] || 0) + 1;
        debug.push({ handle, country, city, confidence: result.confidence, status: 'updated' });
      }
    }

    // 2s delay between creators (skip after last)
    if (i < profiles.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  return NextResponse.json({
    updated,
    skipped,
    failed,
    flagged,
    total: profiles.length,
    byCountry,
    dryRun,
    debug,
  });
}
