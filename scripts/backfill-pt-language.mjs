#!/usr/bin/env node
/**
 * Clears stored Portuguese language labels that the current heuristic no
 * longer gives. Portuguese only; every other language is left as it is.
 *
 * WHY THIS EXISTS. The heuristic used to split "yahoo.com" into the token
 * "com", a Portuguese stopword, and to hand a tie to whichever language its
 * table listed first. Both are fixed in lib/bioSignals.ts. But re-running
 * Intelligence does not clear a label when the new answer is "no label" — it
 * writes only what it finds (deferred-cleanups item 38) — so the bad
 * Portuguese labels stay until something nulls them. Where the new answer is
 * another language, an ordinary Intelligence re-run corrects it; this script
 * does not touch those.
 *
 * WHAT IT DOES, per profile with social_profiles.detected_language = 'pt':
 *   1. Reads the captions exactly as app/api/intelligence/analyze reads them
 *      (caption not null, limit 15, no order) and runs the application's own
 *      detectLanguage over bio + captions.
 *   2. If the answer is no label, nulls social_profiles.detected_language and,
 *      where it is still 'pt', creators.primary_language — marking the creator
 *      ai_embedded = false, as an Intelligence pass does, because the
 *      embedding text carries the language.
 *   3. Skips any creator with more than one social profile: its
 *      primary_language may come from the other one.
 *
 * Every write is guarded on the value still being 'pt', so a label changed by
 * anything else in the meantime is left alone. intelligence_data.languages is
 * not touched; nothing in this repo reads it.
 *
 * Usage:
 *   node scripts/backfill-pt-language.mjs            # dry run: reads only, prints the count
 *   node scripts/backfill-pt-language.mjs --apply    # writes
 */
import fs from 'fs';
import { createRequire } from 'module';
import { buildLibs } from './_build-libs.mjs';

const require = createRequire(import.meta.url);
const { detectLanguage } = require(`${buildLibs(['lib/bioSignals.ts'])}/bioSignals.js`);

const APPLY = process.argv.includes('--apply');

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const U = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' };

const get = async (path) => {
  const r = await fetch(`${U}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${await r.text()}`);
  return r.json();
};

// Ordered by id: PostgREST paging without a stable order skips and repeats rows.
const page = async (path, size = 1000) => {
  const out = [];
  for (let from = 0; ; from += size) {
    const r = await fetch(`${U}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + size - 1}` } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const d = await r.json();
    out.push(...d);
    if (d.length < size) break;
  }
  return out;
};

const chunk = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

console.log(APPLY ? 'APPLY — this run writes.\n' : 'Dry run — reads only. Pass --apply to write.\n');

const profiles = await page('social_profiles?select=id,creator_id,handle,platform,bio,post_language&detected_language=eq.pt&order=id.asc');
console.log(`profiles labelled pt: ${profiles.length}`);

// Captions, read the way the route reads them.
const results = [];
for (const batch of chunk(profiles, 10)) {
  await Promise.all(batch.map(async p => {
    const posts = await get(`creator_posts?select=caption&social_profile_id=eq.${p.id}&caption=not.is.null&limit=15`);
    const captions = posts.map(x => x.caption).filter(Boolean);
    results.push({ ...p, answer: detectLanguage(p.bio || '', captions).primary });
  }));
}

const byAnswer = results.reduce((a, r) => { a[r.answer] = (a[r.answer] || 0) + 1; return a; }, {});
console.log(`new heuristic on those profiles: ${JSON.stringify(byAnswer)}`);
console.log('  pt: unchanged. Another language: left for an ordinary Intelligence re-run.');

const withheld = results.filter(r => r.answer === 'unknown');

// Creators with more than one profile are skipped.
const profileCount = new Map();
for (const ids of chunk([...new Set(withheld.map(r => r.creator_id).filter(Boolean))], 100)) {
  for (const row of await get(`social_profiles?select=creator_id&creator_id=in.(${ids.join(',')})`)) {
    profileCount.set(row.creator_id, (profileCount.get(row.creator_id) || 0) + 1);
  }
}
const skipped = withheld.filter(r => (profileCount.get(r.creator_id) || 0) > 1);
const targets = withheld.filter(r => (profileCount.get(r.creator_id) || 0) <= 1);

const checkable = targets.filter(r => r.post_language);
console.log(`\nwould null: ${targets.length} profiles (skipped, creator has several profiles: ${skipped.length})`);
console.log(`  of those with a TikTok post language to check against: ${checkable.length}, ` +
  `of which post language says pt: ${checkable.filter(r => r.post_language === 'pt').length}`);
console.log('\nsample:');
for (const r of targets.slice(0, 15)) {
  console.log(`  @${r.handle} [${r.platform}] post=${r.post_language || '-'} :: ${JSON.stringify((r.bio || '').replace(/\s+/g, ' ').slice(0, 80))}`);
}

if (!APPLY) process.exit(0);

let profilesWritten = 0, creatorsWritten = 0;
for (const batch of chunk(targets, 100)) {
  const ids = batch.map(r => r.id).join(',');
  const r1 = await fetch(`${U}/rest/v1/social_profiles?id=in.(${ids})&detected_language=eq.pt`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ detected_language: null }),
  });
  if (!r1.ok) throw new Error(`social_profiles: ${r1.status} ${await r1.text()}`);
  profilesWritten += (await r1.json()).length;

  const creatorIds = batch.map(r => r.creator_id).filter(Boolean).join(',');
  if (!creatorIds) continue;
  const r2 = await fetch(`${U}/rest/v1/creators?id=in.(${creatorIds})&primary_language=eq.pt`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ primary_language: null, ai_embedded: false }),
  });
  if (!r2.ok) throw new Error(`creators: ${r2.status} ${await r2.text()}`);
  creatorsWritten += (await r2.json()).length;
}
console.log(`\nwritten: ${profilesWritten} social_profiles, ${creatorsWritten} creators`);
