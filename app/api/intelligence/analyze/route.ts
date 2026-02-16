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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status}`);
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
  data: {
    language: { primary: string; all: string[] };
    location: { country: string | null; city: string | null; raw: string | null };
    emails: string[];
    aiSummary: string | null;
    website: string | null;
  }
) {
  await supabase
    .from('social_profiles')
    .update({
      detected_language: data.language.primary !== 'unknown' ? data.language.primary : null,
      detected_country: data.location.country,
      detected_city: data.location.city,
      detected_email: data.emails[0] || null,
      ai_summary: data.aiSummary,
      intelligence_data: {
        languages: data.language.all,
        location_raw: data.location.raw,
        emails_found: data.emails,
        website: data.website,
      },
      intelligence_updated_at: new Date().toISOString(),
    })
    .eq('id', socialProfileId);

  await supabase
    .from('creators')
    .update({
      primary_language: data.language.primary !== 'unknown' ? data.language.primary : null,
      country: data.location.country,
      city: data.location.city,
      contact_email: data.emails[0] || null,
    })
    .eq('id', creatorId);
}

// ---------------------------------------------------------------------------
// Main POST handler
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  const body = await request.json();
  const {
    mode = 'not_analyzed',
    batchSize = 50,
    extractEmails: doEmails = true,
    detectLanguage: doLanguage = true,
    detectLocation: doLocation = true,
    generateAISummary: doAI = false,
    handles = [],
  } = body;

  // Build query to select profiles
  let query = supabase
    .from('social_profiles')
    .select('id, handle, platform, bio, follower_count, enrichment_data, creator_id')
    .limit(batchSize);

  if (mode === 'not_analyzed') {
    query = query.is('intelligence_updated_at', null);
  } else if (mode === 'enriched_first') {
    query = query
      .is('intelligence_updated_at', null)
      .not('enrichment_data', 'is', null)
      .order('id');
  } else if (mode === 'specific' && handles.length > 0) {
    query = query.in('handle', handles);
  }
  // mode === 're_analyze_all' — no extra filters, just limit

  const { data: profiles, error } = await query;

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
      if (doAI) {
        aiSummary = await generateAISummary(
          profile,
          enrichment,
          captions,
          bio,
          location,
          language.primary
        );
      }

      await saveIntelligence(profile.id, profile.creator_id as string, {
        language,
        location,
        emails,
        aiSummary,
        website,
      });

      results.push({
        handle: profile.handle as string,
        platform: profile.platform as string,
        language: language.primary !== 'unknown' ? language.primary : null,
        country: location.country,
        city: location.city,
        email: emails[0] || null,
        website,
        aiSummary: !!aiSummary,
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
