import { NextRequest, NextResponse } from 'next/server';
import { importScrapedProfiles } from '@/lib/profileImport';
import { parseHandleList, looseHandle } from '@/lib/handles';
import { ACTOR_PRICES_USD } from '@/lib/discoveryCost';
import { supabase } from '@/lib/supabase';
import type { FollowerRange } from '@/lib/followerRange';

/**
 * Manual add: look up a pasted list of handles and save them.
 *
 * ONE path for both platforms. Before this the page orchestrated four requests
 * itself — start the actor, poll its status every 3s with no timeout, fetch
 * the dataset, save in batches of three — through a platform-specific start
 * route and a private copy of each mapper. The TikTok copy predated the
 * 2026-08-29 field-name fix in lib/apify.ts, so every TikTok row it wrote had
 * no name, no avatar and no provenance tag.
 *
 * importScrapedProfiles is what Discovery and brand-feed already use: the
 * actor is chosen by platform, the run is waited on by waitForRun (bounded,
 * and it reports the dataset id on a timeout so the results are recoverable
 * without paying again), items go through the SHARED mappers, and the write
 * is saveDiscoveredCreators with `platform` set. A manual TikTok row therefore
 * comes out identical in shape to a Discovery one.
 *
 * SYNCHRONOUS on purpose. The app is self-hosted (`next start` on the VPS),
 * where maxDuration is inert and nothing kills a long request; a manual add is
 * a handful of handles and one actor run, typically well under a minute. A job
 * id the page polls would add a table and a second route for a wait the
 * operator is already watching. If this ever moves to a platform with a hard
 * request wall, that is the change to make — and MAX_HANDLES is the knob that
 * keeps one request bounded until then.
 *
 * FOLLOWER RANGE IS UNBOUNDED. A hand-typed handle is qualified by the act of
 * typing it, so nothing is archived. One consequence, accepted knowingly: a
 * profile whose follower count comes back 0 or missing (private, deleted,
 * rate-limited) is stamped `unknown_size` rather than the `active` the old
 * client path wrote unconditionally. That is the correct reading — the count
 * was not measured — and enrichment re-measures it; but it does change what
 * the queue filters see for that row, so it is stated here rather than left
 * to be discovered.
 */

export const maxDuration = 300;

/** Handles per request. One Apify run; keeps the synchronous wait short. */
export const MAX_HANDLES = 100;

const UNBOUNDED: FollowerRange = { min: 0, max: Number.MAX_SAFE_INTEGER };

export type LookupStatus = 'saved' | 'existing' | 'not_found' | 'error';

export interface LookupRow {
  handle: string;
  status: LookupStatus;
  /** Why, for 'error'; what it resolved to, for a renamed account. */
  message?: string;
  displayName: string | null;
  followerCount: number | null;
  engagementRate: number | null;
  profileUrl: string | null;
  hasPic: boolean;
  importStatus: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const platform = body.platform === 'tiktok' ? 'tiktok' : body.platform === 'instagram' ? 'instagram' : null;
    if (!platform) {
      return NextResponse.json({ error: 'platform must be "instagram" or "tiktok"' }, { status: 400 });
    }

    // Parsed server-side as well as on the page, so a caller that is not the
    // page gets the same URL handling and the same rejections.
    const rawHandles: string = Array.isArray(body.handles)
      ? body.handles.map(String).join('\n')
      : String(body.handles ?? '');
    const parsed = parseHandleList(rawHandles);

    if (parsed.valid.length === 0) {
      return NextResponse.json(
        { error: 'No valid handles', invalid: parsed.invalid },
        { status: 400 },
      );
    }
    if (parsed.valid.length > MAX_HANDLES) {
      return NextResponse.json(
        { error: `At most ${MAX_HANDLES} handles per request (got ${parsed.valid.length})`, invalid: parsed.invalid },
        { status: 400 },
      );
    }

    const outcome = await importScrapedProfiles(parsed.valid, {
      platform,
      range: UNBOUNDED,
      discoveredViaHashtags: ['manual_entry'],
    });

    // ── Per-handle verdicts ──────────────────────────────────────────────────
    //
    // Four states, decided the way Discovery decides scrape_missing: a handle
    // the actor returned is measured; a handle whose batch completed but that
    // the actor did not return is not found; a handle whose batch threw (or
    // timed out) is an error, not a missing profile.
    const measured = new Map(outcome.measured.map(m => [m.handle, m]));
    const scraped = new Set(outcome.scrapedHandles);
    const errorFor = (handle: string) =>
      outcome.errors.find(e => e.startsWith(`${handle}:`))?.slice(handle.length + 1).trim()
      ?? outcome.errors[0]
      ?? 'unknown error';

    const verdicts = new Map<string, { status: LookupStatus; message?: string }>();
    for (const handle of parsed.valid) {
      const m = measured.get(handle);
      if (m) {
        verdicts.set(handle, m.saved
          ? { status: m.existing ? 'existing' : 'saved' }
          : { status: 'error', message: errorFor(handle) });
      } else if (scraped.has(handle)) {
        verdicts.set(handle, { status: 'not_found' });
      } else {
        verdicts.set(handle, { status: 'error', message: errorFor(handle) });
      }
    }
    // An actor may resolve a handle to a different current username. Surface
    // it rather than losing it: it was paid for and it was written.
    for (const m of outcome.measured) {
      if (verdicts.has(m.handle)) continue;
      verdicts.set(m.handle, m.saved
        ? { status: m.existing ? 'existing' : 'saved', message: 'returned by the actor under this name; not in the pasted list' }
        : { status: 'error', message: errorFor(m.handle) });
    }

    // ── Hydrate from the database, not the scrape payload ───────────────────
    // What the page shows is what was written, which is the thing the operator
    // is checking. Both views span populations, in case an existing handle
    // belongs to an archived creator.
    const written = [...verdicts.entries()]
      .filter(([, v]) => v.status === 'saved' || v.status === 'existing')
      .map(([h]) => h);

    const profileByHandle = new Map<string, Record<string, unknown>>();
    const displayNameByCreator = new Map<string, string | null>();

    if (written.length > 0) {
      const { data: profiles, error: profileError } = await supabase
        .from('v_social_profiles_all')
        .select('handle, creator_id, follower_count, engagement_rate, profile_url, profile_pic_url, import_status')
        .eq('platform', platform)
        .in('handle', written);
      if (profileError) throw new Error(`profile read-back failed: ${profileError.message}`);
      for (const p of profiles || []) profileByHandle.set(looseHandle(p.handle), p);

      const creatorIds = [...new Set((profiles || []).map(p => String(p.creator_id)))];
      if (creatorIds.length > 0) {
        const { data: creators, error: creatorError } = await supabase
          .from('v_creators_all')
          .select('id, display_name')
          .in('id', creatorIds);
        if (creatorError) throw new Error(`creator read-back failed: ${creatorError.message}`);
        for (const c of creators || []) displayNameByCreator.set(String(c.id), c.display_name ?? null);
      }
    }

    const rows: LookupRow[] = [...verdicts.entries()].map(([handle, v]) => {
      const p = profileByHandle.get(handle);
      return {
        handle,
        status: v.status,
        ...(v.message ? { message: v.message } : {}),
        displayName: p ? displayNameByCreator.get(String(p.creator_id)) ?? null : null,
        followerCount: p ? (p.follower_count as number | null) ?? null : null,
        engagementRate: p ? (p.engagement_rate as number | null) ?? null : null,
        profileUrl: p ? (p.profile_url as string | null) ?? null : null,
        hasPic: !!(p && p.profile_pic_url),
        importStatus: p ? (p.import_status as string | null) ?? null : null,
      };
    });

    const count = (s: LookupStatus) => rows.filter(r => r.status === s).length;

    return NextResponse.json({
      platform,
      rows,
      invalid: parsed.invalid,
      summary: {
        attempted: parsed.valid.length,
        saved: count('saved'),
        existing: count('existing'),
        notFound: count('not_found'),
        errors: count('error'),
        unknownSize: outcome.unknownSize,
        timedOut: outcome.timedOut,
      },
      /** The actor's list price at the FREE tier; the run's own bill is on Apify. */
      estimatedCostUsd: parsed.valid.length * ACTOR_PRICES_USD[platform].profileResult,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Lookup failed';
    console.error('Manual add lookup error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
