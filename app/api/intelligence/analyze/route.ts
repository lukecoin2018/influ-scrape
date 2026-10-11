import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { fetchAllRows } from '@/lib/supabasePaging';
import { detectLocation, detectLanguage, mayWriteEmailTldCountry, type DetectedLocation } from '@/lib/bioSignals';

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
    location: DetectedLocation;
    emails: string[];
    aiSummary: string | null;
    website: string | null;
  }
) {
  // A field is only included in the update when its extraction step both ran
  // AND actually produced a value. A disabled flag must leave the existing
  // stored value alone (fixed previously) — but an enabled flag isn't a
  // license to write null either: bio-based detection finding nothing this
  // pass (empty bio, no location/language/email signal in the text) does
  // not mean the creator's real country/language/email is now unknown, so
  // that case must also preserve whatever's already stored. intelligence_data
  // is a single JSONB column, so it's merged in JS against the current value
  // rather than replaced.
  const profileUpdate: Record<string, unknown> = {
    intelligence_updated_at: new Date().toISOString(),
  };
  const creatorUpdate: Record<string, unknown> = {
    ai_embedded: false, // mark as needing re-embed with new intelligence data
  };
  const mergedIntelligenceData: Record<string, unknown> = { ...(currentIntelligenceData || {}) };

  if (flags.doLanguage && data.language.primary !== 'unknown') {
    profileUpdate.detected_language = data.language.primary;
    creatorUpdate.primary_language = data.language.primary;
    mergedIntelligenceData.languages = data.language.all;
  }

  if (flags.doLocation) {
    // Country and city are independent signals — e.g. a flag emoji resolves
    // country with no city mentioned. Each is only written when found, so a
    // miss on one doesn't clear a previously stored value on the other.
    //
    // An email-TLD country reaching this point has already been cleared by
    // mayWriteEmailTldCountry. It is marked in intelligence_data.country_source
    // so extract-locations still treats the row as open and a later bio signal
    // replaces it; a bio signal clears the marker.
    if (data.location.country && data.location.countrySource === 'email_tld') {
      profileUpdate.detected_country = data.location.country;
      creatorUpdate.country = data.location.country;
      mergedIntelligenceData.country_source = 'email_tld';
    } else if (data.location.country) {
      profileUpdate.detected_country = data.location.country;
      creatorUpdate.country = data.location.country;
      delete mergedIntelligenceData.country_source;
    }
    if (data.location.city) {
      profileUpdate.detected_city = data.location.city;
      creatorUpdate.city = data.location.city;
    }
    if (data.location.raw) {
      mergedIntelligenceData.location_raw = data.location.raw;
    }
  }

  if (flags.doEmails && data.emails.length > 0) {
    profileUpdate.detected_email = data.emails[0];
    creatorUpdate.contact_email = data.emails[0];
    mergedIntelligenceData.emails_found = data.emails;
  }

  // Website has no toggle — always recomputed from bio, but only persisted
  // when found, for the same "no signal isn't a license to null" reason.
  if (data.website) {
    mergedIntelligenceData.website = data.website;
  }

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
    // Column-to-column comparison, so the rows are genuinely needed. Paged
    // rather than capped: truncation here would silently shrink the
    // re-analysis queue rather than erroring.
    const candidates = await fetchAllRows<Record<string, unknown>>(() => supabase
      .from('social_profiles')
      .select('id, handle, platform, bio, follower_count, enrichment_data, creator_id, enriched_at, intelligence_updated_at, intelligence_data, detected_country, place_country_code')
      .eq('import_status', 'active')
      .not('enriched_at', 'is', null)
      .not('intelligence_updated_at', 'is', null)
      .order('id', { ascending: true }));
    const candidatesError = null;

    profiles = candidates
      .filter((p) => new Date(p.enriched_at as string).getTime() > new Date(p.intelligence_updated_at as string).getTime())
      .sort((a, b) => new Date(b.enriched_at as string).getTime() - new Date(a.enriched_at as string).getTime())
      .slice(0, batchSize);
    error = candidatesError;
  } else {
    let query = supabase
      .from('social_profiles')
      .select('id, handle, platform, bio, follower_count, enrichment_data, creator_id, intelligence_data, detected_country, place_country_code');

    // 'specific' is a deliberate manual override: a hand-typed handle wins
    // over the import_status gate. Every other mode respects it.
    if (mode !== 'specific') {
      query = query.eq('import_status', 'active');
    }

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
      // Emails are read for the location fallback whether or not doEmails is
      // set; doEmails only governs whether they are stored.
      const detected: DetectedLocation = doLocation
        ? detectLocation(bio, extractEmails(bio))
        : { country: null, city: null, raw: null, countrySource: null };
      // The email-TLD country is a fallback, used only when nothing else has
      // set a country — not this bio, not a stored country from any source,
      // not a geotag. When it may not be written it is dropped here, so it
      // reaches neither the database nor the result row.
      const intelligenceData = profile.intelligence_data as Record<string, unknown> | null;
      const fallbackBlocked = detected.countrySource === 'email_tld' && !mayWriteEmailTldCountry({
        detectedCountry: (profile.detected_country as string | null) ?? null,
        placeCountryCode: (profile.place_country_code as string | null) ?? null,
        countrySource: typeof intelligenceData?.country_source === 'string' ? intelligenceData.country_source : null,
      });
      const location: DetectedLocation = fallbackBlocked
        ? { ...detected, country: null, countrySource: null }
        : detected;
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
            // Without the email-TLD country: extract-locations reads this
            // summary back, and a guess stated in it would return as a
            // confident answer.
            location.countrySource === 'email_tld' ? { ...location, country: null } : location,
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
        intelligenceData ?? null,
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
