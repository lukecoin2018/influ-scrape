import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ---------------------------------------------------------------------------
// Email extraction
// ---------------------------------------------------------------------------
function extractEmails(bio: string): string[] {
  if (!bio) return [];
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const direct = bio.match(emailRegex) || [];

  const obfuscated: string[] = [];
  const obfuscatedRegex =
    /([a-zA-Z0-9._%+-]+)\s*[\(\[{]?\s*(?:at|@)\s*[\)\]}]?\s*([a-zA-Z0-9.-]+)\s*[\(\[{]?\s*(?:dot|\.)\s*[\)\]}]?\s*([a-zA-Z]{2,})/gi;
  let match;
  while ((match = obfuscatedRegex.exec(bio)) !== null) {
    obfuscated.push(`${match[1]}@${match[2]}.${match[3]}`.toLowerCase());
  }

  return [...new Set([...direct, ...obfuscated].map((e) => e.toLowerCase()))];
}

// ---------------------------------------------------------------------------
// Website extraction
// ---------------------------------------------------------------------------
function extractWebsite(bio: string): string | null {
  if (!bio) return null;
  const urlRegex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/g;
  const matches = bio.match(urlRegex) || [];
  const socialDomains = [
    'instagram.com', 'tiktok.com', 'youtube.com', 'twitter.com',
    'x.com', 'facebook.com', 'snapchat.com', 'threads.net',
    'linktr.ee', 'linktree.com', 'beacons.ai',
  ];
  const websites = matches.filter((url) => {
    const lower = url.toLowerCase();
    return !socialDomains.some((d) => lower.includes(d));
  });
  return websites[0] || null;
}

// ---------------------------------------------------------------------------
// Location detection
// ---------------------------------------------------------------------------
function detectLocation(bio: string): { country: string | null; city: string | null; raw: string | null } {
  if (!bio) return { country: null, city: null, raw: null };

  const flagMap: Record<string, string> = {
    '🇺🇸': 'United States', '🇬🇧': 'United Kingdom', '🇩🇪': 'Germany',
    '🇫🇷': 'France', '🇪🇸': 'Spain', '🇮🇹': 'Italy',
    '🇳🇱': 'Netherlands', '🇧🇪': 'Belgium', '🇦🇹': 'Austria',
    '🇨🇭': 'Switzerland', '🇸🇪': 'Sweden', '🇩🇰': 'Denmark',
    '🇳🇴': 'Norway', '🇵🇹': 'Portugal', '🇧🇷': 'Brazil',
    '🇲🇽': 'Mexico', '🇨🇦': 'Canada', '🇦🇺': 'Australia',
    '🇯🇵': 'Japan', '🇰🇷': 'South Korea', '🇮🇳': 'India',
    '🇹🇷': 'Turkey', '🇿🇦': 'South Africa', '🇦🇪': 'UAE',
    '🇸🇦': 'Saudi Arabia', '🇵🇱': 'Poland', '🇷🇴': 'Romania',
    '🇭🇺': 'Hungary', '🇨🇿': 'Czech Republic', '🇬🇷': 'Greece',
    '🇮🇪': 'Ireland', '🇫🇮': 'Finland', '🇭🇷': 'Croatia',
    '🇷🇸': 'Serbia', '🇧🇬': 'Bulgaria', '🇺🇦': 'Ukraine',
    '🇵🇭': 'Philippines', '🇮🇩': 'Indonesia', '🇹🇭': 'Thailand',
    '🇻🇳': 'Vietnam', '🇲🇾': 'Malaysia', '🇸🇬': 'Singapore',
    '🇳🇬': 'Nigeria', '🇰🇪': 'Kenya', '🇪🇬': 'Egypt',
    '🇨🇴': 'Colombia', '🇦🇷': 'Argentina', '🇨🇱': 'Chile', '🇵🇪': 'Peru',
  };

  const cityMap: Record<string, string> = {
    'new york': 'United States', 'nyc': 'United States', 'los angeles': 'United States',
    'la': 'United States', 'chicago': 'United States', 'miami': 'United States',
    'san francisco': 'United States', 'sf': 'United States', 'atlanta': 'United States',
    'houston': 'United States', 'dallas': 'United States', 'seattle': 'United States',
    'boston': 'United States', 'nashville': 'United States', 'denver': 'United States',
    'london': 'United Kingdom', 'manchester': 'United Kingdom', 'birmingham': 'United Kingdom',
    'edinburgh': 'United Kingdom', 'glasgow': 'United Kingdom', 'liverpool': 'United Kingdom',
    'berlin': 'Germany', 'munich': 'Germany', 'münchen': 'Germany',
    'hamburg': 'Germany', 'frankfurt': 'Germany', 'cologne': 'Germany', 'köln': 'Germany',
    'düsseldorf': 'Germany', 'stuttgart': 'Germany',
    'paris': 'France', 'lyon': 'France', 'marseille': 'France',
    'madrid': 'Spain', 'barcelona': 'Spain', 'valencia': 'Spain',
    'rome': 'Italy', 'milan': 'Italy', 'milano': 'Italy',
    'amsterdam': 'Netherlands', 'rotterdam': 'Netherlands',
    'brussels': 'Belgium', 'antwerp': 'Belgium',
    'vienna': 'Austria', 'wien': 'Austria',
    'zurich': 'Switzerland', 'zürich': 'Switzerland', 'geneva': 'Switzerland',
    'stockholm': 'Sweden', 'copenhagen': 'Denmark', 'oslo': 'Norway',
    'lisbon': 'Portugal', 'dublin': 'Ireland', 'helsinki': 'Finland',
    'prague': 'Czech Republic', 'warsaw': 'Poland', 'budapest': 'Hungary',
    'athens': 'Greece', 'istanbul': 'Turkey',
    'toronto': 'Canada', 'vancouver': 'Canada', 'montreal': 'Canada',
    'sydney': 'Australia', 'melbourne': 'Australia',
    'tokyo': 'Japan', 'seoul': 'South Korea',
    'mumbai': 'India', 'delhi': 'India', 'bangalore': 'India',
    'dubai': 'UAE', 'abu dhabi': 'UAE',
    'são paulo': 'Brazil', 'rio de janeiro': 'Brazil',
    'mexico city': 'Mexico', 'buenos aires': 'Argentina',
    'cape town': 'South Africa', 'johannesburg': 'South Africa',
    'lagos': 'Nigeria', 'nairobi': 'Kenya', 'cairo': 'Egypt',
  };

  let country: string | null = null;
  let city: string | null = null;
  let raw: string | null = null;

  // Flag emojis
  for (const [flag, countryName] of Object.entries(flagMap)) {
    if (bio.includes(flag)) { country = countryName; break; }
  }

  // 📍 pin pattern
  const pinMatch = bio.match(/📍\s*([^,\n]+(?:,\s*[^,\n]+)?)/);
  if (pinMatch) raw = pinMatch[1].trim();

  // "Based in / From / Living in" pattern
  const basedInMatch = bio.match(/(?:based in|from|living in|located in)\s+([A-Za-zÀ-ÿ\s]+)/i);
  if (basedInMatch) raw = raw || basedInMatch[1].trim();

  // City matching
  const bioLower = bio.toLowerCase();
  for (const [cityName, countryName] of Object.entries(cityMap)) {
    const regex = new RegExp(`\\b${cityName}\\b`, 'i');
    if (regex.test(bioLower)) {
      city = cityName.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (!country) country = countryName;
      break;
    }
  }

  // Country name direct mention
  if (!country) {
    const countryNames = [...new Set([...Object.values(flagMap), ...Object.values(cityMap)])];
    for (const c of countryNames) {
      if (bioLower.includes(c.toLowerCase())) { country = c; break; }
    }
  }

  return { country, city, raw };
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------
function detectLanguage(bio: string, captions: string[]): { primary: string; all: string[] } {
  const allText = [bio, ...captions.slice(0, 5)].filter(Boolean).join(' ');
  if (!allText || allText.length < 20) return { primary: 'unknown', all: [] };

  const languageSignals: Record<string, string[]> = {
    en: ['the', 'and', 'you', 'for', 'this', 'with', 'that', 'have', 'from', 'your', 'just', 'love', 'new', 'day', 'out', 'about', 'what', 'when'],
    de: ['und', 'die', 'der', 'das', 'ist', 'ich', 'nicht', 'ein', 'mit', 'auch', 'auf', 'für', 'mein', 'aber', 'wir', 'noch', 'wie', 'hier'],
    es: ['que', 'los', 'las', 'del', 'por', 'con', 'una', 'para', 'esta', 'como', 'pero', 'más', 'todo', 'sus', 'muy', 'también'],
    fr: ['les', 'des', 'une', 'est', 'que', 'pour', 'pas', 'dans', 'sur', 'avec', 'plus', 'tout', 'cette', 'mon', 'mais', 'aussi'],
    it: ['che', 'non', 'per', 'una', 'con', 'sono', 'questo', 'come', 'anche', 'più', 'della', 'molto', 'tutto', 'mia', 'dalla'],
    pt: ['que', 'não', 'para', 'com', 'uma', 'mais', 'como', 'mas', 'por', 'muito', 'sua', 'esta', 'também', 'isso', 'quando'],
    nl: ['het', 'een', 'van', 'dat', 'niet', 'met', 'voor', 'ook', 'maar', 'wel', 'nog', 'naar', 'deze', 'mijn', 'haar'],
    tr: ['bir', 'bu', 'için', 'ile', 'çok', 'olan', 'gibi', 'daha', 'ben', 'var', 'ama', 'kadar', 'olarak'],
    ar: ['في', 'من', 'على', 'إلى', 'هذا', 'عن', 'مع', 'لا', 'ما', 'هو', 'كل'],
  };

  const words = allText.toLowerCase().split(/[\s,.!?;:'"()\[\]{}#@]+/).filter((w) => w.length > 1);
  const scores: Record<string, number> = {};

  for (const [lang, signals] of Object.entries(languageSignals)) {
    scores[lang] = 0;
    for (const word of words) {
      if (signals.includes(word)) scores[lang]++;
    }
  }

  const sorted = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) return { primary: 'unknown', all: [] };

  const primary = sorted[0][0];
  const all = sorted.filter(([, score]) => score > 2).map(([lang]) => lang);
  return { primary, all: all.length > 0 ? all : [primary] };
}

// ---------------------------------------------------------------------------
// AI Summary (Claude)
// ---------------------------------------------------------------------------
async function generateAISummary(
  profile: Record<string, unknown>,
  enrichment: Record<string, unknown> | null,
  captions: string[],
  bio: string,
  location: { country: string | null; city: string | null },
  language: string
): Promise<string> {
  const context: string[] = [];

  context.push(`Handle: @${profile.handle}`);
  context.push(`Platform: ${profile.platform}`);
  if (bio) context.push(`Bio: ${bio}`);
  if (profile.follower_count) context.push(`Followers: ${profile.follower_count}`);
  if (enrichment?.calculated_engagement_rate) context.push(`Engagement rate: ${enrichment.calculated_engagement_rate}%`);
  if (enrichment?.posting_frequency_per_week) context.push(`Posts per week: ${enrichment.posting_frequency_per_week}`);
  if (enrichment?.content_mix) context.push(`Content mix: ${JSON.stringify(enrichment.content_mix)}`);
  if ((enrichment?.top_hashtags as string[])?.length) context.push(`Top hashtags: ${(enrichment!.top_hashtags as string[]).join(', ')}`);
  if ((enrichment?.detected_brands as string[])?.length) context.push(`Brand partnerships: ${(enrichment!.detected_brands as string[]).join(', ')}`);
  if (location.city) context.push(`City: ${location.city}`);
  if (location.country) context.push(`Country: ${location.country}`);
  if (language !== 'unknown') context.push(`Primary language: ${language}`);

  if (captions.length > 0) {
    context.push('Recent captions (sample):');
    captions.slice(0, 5).forEach((c, i) => {
      context.push(`Caption ${i + 1}: ${c.slice(0, 300)}`);
    });
  }

  const prompt = `You are an influencer marketing analyst. Based on the following creator data, write a concise 3-4 sentence summary of this creator for a brand considering a partnership. Describe what they create, their style/tone, what kind of brands would be a good fit, and any notable strengths or signals.

Be specific and useful — don't be generic. Reference actual data points. Write in third person.

CREATOR DATA:
${context.join('\n')}

Write ONLY the summary, no preamble, no labels, no quotes.`;

  const callClaude = async (promptText: string): Promise<Response> => {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: promptText }],
      }),
    });
  };

  let response = await callClaude(prompt);

  // If prompt too large (400), retry with trimmed context (captions shortened, fewer included)
  if (response.status === 400) {
    const trimmedContext = context.map(line => {
      if (line.startsWith('Caption')) return line.slice(0, line.indexOf(':') + 152); // ~150 chars per caption
      if (line.startsWith('Bio:')) return line.slice(0, 160); // ~150 chars of bio
      return line;
    }).slice(0, 12); // cap total context lines

    const trimmedPrompt = `You are an influencer marketing analyst. Based on the following creator data, write a concise 3-4 sentence summary of this creator for a brand considering a partnership. Describe what they create, their style/tone, what kind of brands would be a good fit, and any notable strengths or signals.

Be specific and useful — don't be generic. Reference actual data points. Write in third person.

CREATOR DATA:
${trimmedContext.join('\n')}

Write ONLY the summary, no preamble, no labels, no quotes.`;

    response = await callClaude(trimmedPrompt);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '(could not read body)');
    console.error(`[Claude API] status=${response.status} body=${errorBody}`);
    throw new Error(`Claude API error: ${response.status} — ${errorBody}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// ---------------------------------------------------------------------------
// Save intelligence data
// ---------------------------------------------------------------------------
async function saveIntelligence(
  socialProfileId: string,
  creatorId: string,
  currentIntelligenceData: Record<string, unknown> | null,
  flags: { doEmails: boolean; doLanguage: boolean; doLocation: boolean; doAI: boolean },
  data: {
    language: { primary: string; all: string[] };
    location: { country: string | null; city: string | null; raw: string | null };
    emails: string[];
    aiSummary: string | null;
    website: string | null;
  }
) {
  // Only include a column in the update if its extraction step actually ran
  // this pass — a disabled flag must leave the existing stored value alone,
  // not overwrite it with null. intelligence_data is a single JSONB column,
  // so it's merged in JS against the current value rather than replaced.
  const profileUpdate: Record<string, unknown> = {
    intelligence_updated_at: new Date().toISOString(),
  };
  const creatorUpdate: Record<string, unknown> = {
    ai_embedded: false, // mark as needing re-embed with new intelligence data
  };
  const mergedIntelligenceData: Record<string, unknown> = { ...(currentIntelligenceData || {}) };

  if (flags.doLanguage) {
    const detectedLanguage = data.language.primary !== 'unknown' ? data.language.primary : null;
    profileUpdate.detected_language = detectedLanguage;
    creatorUpdate.primary_language = detectedLanguage;
    mergedIntelligenceData.languages = data.language.all;
  }

  if (flags.doLocation) {
    profileUpdate.detected_country = data.location.country;
    profileUpdate.detected_city = data.location.city;
    creatorUpdate.country = data.location.country;
    creatorUpdate.city = data.location.city;
    mergedIntelligenceData.location_raw = data.location.raw;
  }

  if (flags.doEmails) {
    const email = data.emails[0] || null;
    profileUpdate.detected_email = email;
    creatorUpdate.contact_email = email;
    mergedIntelligenceData.emails_found = data.emails;
  }

  // Website has no toggle — always recomputed from bio, safe to always persist.
  mergedIntelligenceData.website = data.website;

  if (flags.doAI) {
    // Persisted whether generation succeeded or not — a null here (failure)
    // intentionally marks the summary as pending again for the next run.
    profileUpdate.ai_summary = data.aiSummary;
  }

  profileUpdate.intelligence_data = mergedIntelligenceData;

  const { error: profileError } = await supabase
    .from('social_profiles')
    .update(profileUpdate)
    .eq('id', socialProfileId);
  if (profileError) throw profileError;

  const { error: creatorError } = await supabase
    .from('creators')
    .update(creatorUpdate)
    .eq('id', creatorId);
  if (creatorError) throw creatorError;
}

// ---------------------------------------------------------------------------
// Main POST handler
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  const body = await request.json();
  const {
    mode = 'not_analyzed',
    batchSize = 50,
    offset = 0,
    extractEmails: doEmails = true,
    detectLanguage: doLanguage = true,
    detectLocation: doLocation = true,
    generateAISummary: doAI = false,
    handles = [],
  } = body;

  // Build query to select profiles
  let profiles: Array<Record<string, unknown>> | null;
  let error: { message: string } | null;

  if (mode === 'needs_reanalysis') {
    // "Enriched more recently than last analyzed" is a column-to-column
    // comparison, which PostgREST filters can't express directly — so pull
    // candidates (both timestamps set) and filter/sort/limit in JS. NULL
    // intelligence_updated_at is excluded — those belong to "Not yet analyzed".
    const { data: candidates, error: candidatesError } = await supabase
      .from('social_profiles')
      .select('id, handle, platform, bio, follower_count, enrichment_data, creator_id, enriched_at, intelligence_updated_at, intelligence_data')
      .not('enriched_at', 'is', null)
      .not('intelligence_updated_at', 'is', null);

    profiles = (candidates || [])
      .filter((p) => new Date(p.enriched_at as string).getTime() > new Date(p.intelligence_updated_at as string).getTime())
      .sort((a, b) => new Date(b.enriched_at as string).getTime() - new Date(a.enriched_at as string).getTime())
      .slice(0, batchSize);
    error = candidatesError;
  } else {
    let query = supabase
      .from('social_profiles')
      .select('id, handle, platform, bio, follower_count, enrichment_data, creator_id, intelligence_data');

    if (mode === 'not_analyzed') {
      // Queue-based: intelligence_updated_at is set on every processed row,
      // so each call naturally sees the next still-pending batch — no offset.
      query = query.is('intelligence_updated_at', null).limit(batchSize);
    } else if (mode === 'enriched_first') {
      query = query
        .is('intelligence_updated_at', null)
        .not('enrichment_data', 'is', null)
        .order('id')
        .limit(batchSize);
    } else if (mode === 'missing_ai_summary') {
      // Queue-based via ai_summary, but only converges if generateAISummary
      // is enabled — otherwise ai_summary never gets set and the same rows
      // are returned every chunk (bounded by the caller's chunk count, not
      // an infinite loop, but a no-op run if AI summaries are disabled).
      query = query.is('ai_summary', null).limit(batchSize);
    } else if (mode === 'specific' && handles.length > 0) {
      query = query.in('handle', handles).limit(batchSize);
    } else {
      // re_analyze_all — no natural queue-exit filter, so page through
      // explicitly via offset with a stable order.
      query = query.order('id').range(offset, offset + batchSize - 1);
    }

    const result = await query;
    profiles = result.data;
    error = result.error;
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ message: 'No profiles to process', results: [] });
  }

  const results: Array<{
    handle: string;
    platform: string;
    language: string | null;
    country: string | null;
    city: string | null;
    email: string | null;
    website: string | null;
    aiSummary: boolean;
    error?: string;
  }> = [];

  for (const profile of profiles) {
    try {
      const bio = (profile.bio as string) || '';
      const enrichment = profile.enrichment_data as Record<string, unknown> | null;

      // Fetch captions from creator_posts for this profile
      const { data: posts } = await supabase
        .from('creator_posts')
        .select('caption')
        .eq('social_profile_id', profile.id)
        .not('caption', 'is', null)
        .limit(15);

      const captions = (posts || []).map((p: { caption: string }) => p.caption).filter(Boolean);

      // Run extraction
      const emails = doEmails ? extractEmails(bio) : [];
      const location = doLocation ? detectLocation(bio) : { country: null, city: null, raw: null };
      const language = doLanguage ? detectLanguage(bio, captions) : { primary: 'unknown', all: [] };
      const website = extractWebsite(bio);

      let aiSummary: string | null = null;
      let aiSkipped = false;
      if (doAI) {
        try {
          aiSummary = await generateAISummary(
            profile,
            enrichment,
            captions,
            bio,
            location,
            language.primary
          );
        } catch (err) {
          aiSkipped = true;
          console.error(`AI summary failed for ${profile.handle}:`, err instanceof Error ? err.message : err);
          // Save everything else, leave ai_summary as null so it gets picked up next run
        }
      }

      await saveIntelligence(
        profile.id as string,
        profile.creator_id as string,
        (profile.intelligence_data as Record<string, unknown> | null) ?? null,
        { doEmails, doLanguage, doLocation, doAI },
        {
          language,
          location,
          emails,
          aiSummary,
          website,
        }
      );

      results.push({
        handle: profile.handle as string,
        platform: profile.platform as string,
        language: language.primary !== 'unknown' ? language.primary : null,
        country: location.country,
        city: location.city,
        email: emails[0] || null,
        website,
        aiSummary: !!aiSummary,
        ...(aiSkipped && { error: 'AI summary skipped (will retry next run)' }),
      });
    } catch (err) {
      console.error(`Error processing ${profile.handle}:`, err);
      results.push({
        handle: profile.handle as string,
        platform: profile.platform as string,
        language: null,
        country: null,
        city: null,
        email: null,
        website: null,
        aiSummary: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  const succeeded = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => !!r.error).length;

  return NextResponse.json({ succeeded, failed, total: results.length, results });
}
