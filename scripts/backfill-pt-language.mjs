#!/usr/bin/env node
/**
 * Brings stored Portuguese language labels in line with the current
 * heuristic. Only rows labelled 'pt' are touched; every other language is
 * left as it is.
 *
 * WHY THIS EXISTS. The heuristic used to split "yahoo.com" into the token
 * "com", a Portuguese stopword, and to hand a tie to whichever language its
 * table listed first. Both are fixed in lib/bioSignals.ts, but the stored
 * labels do not follow on their own:
 *
 *   - Where the new answer is NO label, re-running Intelligence keeps the old
 *     one — it writes only what it finds (deferred-cleanups item 38).
 *   - Where the new answer is ANOTHER language, a re-run would write it, but
 *     nothing reliably re-runs these profiles. The default queue ("Not yet
 *     analyzed") never revisits an analysed profile. Measured 2026-10-11 on the
 *     104 in this group: "Needs re-analysis" reaches 87 of them (re-enriched
 *     since their last analysis), only if someone runs that mode; 17 are
 *     reached by no queue mode, only by "Re-analyze all" or by handle.
 *
 * WHAT IT DOES, per profile with social_profiles.detected_language = 'pt':
 *   1. Reads the captions exactly as app/api/intelligence/analyze reads them
 *      (caption not null, limit 15, no order) and runs the application's own
 *      detectLanguage over bio + captions.
 *   2. No label: nulls social_profiles.detected_language and, where it is
 *      still 'pt', creators.primary_language.
 *   3. Another language: writes that language to both, the same value an
 *      Intelligence pass would write. Still 'pt': nothing.
 *   4. Marks each changed creator ai_embedded = false, as an Intelligence pass
 *      does, because the embedding text carries the language.
 *   5. Skips any creator with more than one social profile: its
 *      primary_language may come from the other one.
 *
 * Every write is guarded on the value still being 'pt', so a label changed by
 * anything else in the meantime is left alone. intelligence_data.languages is
 * not touched; nothing in this repo reads it. Nor is intelligence_updated_at:
 * this is not an Intelligence pass.
 *
 * Usage:
 *   node scripts/backfill-pt-language.mjs            # dry run: reads only, prints the counts
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

// 'unknown' -> null; another language -> that language; 'pt' -> untouched.
const changing = results
  .filter(r => r.answer !== 'pt')
  .map(r => ({ ...r, newLabel: r.answer === 'unknown' ? null : r.answer }));

// Creators with more than one profile are skipped.
const profileCount = new Map();
for (const ids of chunk([...new Set(changing.map(r => r.creator_id).filter(Boolean))], 100)) {
  for (const row of await get(`social_profiles?select=creator_id&creator_id=in.(${ids.join(',')})`)) {
    profileCount.set(row.creator_id, (profileCount.get(row.creator_id) || 0) + 1);
  }
}
const skipped = changing.filter(r => (profileCount.get(r.creator_id) || 0) > 1);
const targets = changing.filter(r => (profileCount.get(r.creator_id) || 0) <= 1);

const report = (label, rows) => {
  const checkable = rows.filter(r => r.post_language);
  const agree = label === 'null'
    ? `of which post language says pt: ${checkable.filter(r => r.post_language === 'pt').length}`
    : `of which post language agrees with the new label: ${checkable.filter(r => r.post_language === r.newLabel).length}, says pt: ${checkable.filter(r => r.post_language === 'pt').length}`;
  console.log(`  ${label.padEnd(8)} ${String(rows.length).padStart(4)}   with a TikTok post language: ${checkable.length}, ${agree}`);
};
const toNull = targets.filter(r => r.newLabel === null);
const relabel = targets.filter(r => r.newLabel !== null);
console.log(`\nwould change: ${targets.length} profiles (skipped, creator has several profiles: ${skipped.length})`);
report('null', toNull);
report('relabel', relabel);
console.log(`  relabel to: ${JSON.stringify(relabel.reduce((a, r) => { a[r.newLabel] = (a[r.newLabel] || 0) + 1; return a; }, {}))}`);
console.log('\nsample:');
for (const r of [...toNull.slice(0, 8), ...relabel.slice(0, 8)]) {
  console.log(`  @${r.handle} [${r.platform}] pt -> ${r.newLabel ?? 'null'} post=${r.post_language || '-'} :: ${JSON.stringify((r.bio || '').replace(/\s+/g, ' ').slice(0, 80))}`);
}

if (!APPLY) process.exit(0);

// One PATCH per (target label, batch), each guarded on the value still being 'pt'.
let profilesWritten = 0, creatorsWritten = 0;
const byLabel = new Map();
for (const r of targets) {
  const key = r.newLabel ?? '';
  if (!byLabel.has(key)) byLabel.set(key, []);
  byLabel.get(key).push(r);
}
for (const [key, rows] of byLabel) {
  const label = key === '' ? null : key;
  for (const batch of chunk(rows, 100)) {
    const ids = batch.map(r => r.id).join(',');
    const r1 = await fetch(`${U}/rest/v1/social_profiles?id=in.(${ids})&detected_language=eq.pt`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ detected_language: label }),
    });
    if (!r1.ok) throw new Error(`social_profiles: ${r1.status} ${await r1.text()}`);
    profilesWritten += (await r1.json()).length;

    const creatorIds = batch.map(r => r.creator_id).filter(Boolean).join(',');
    if (!creatorIds) continue;
    const r2 = await fetch(`${U}/rest/v1/creators?id=in.(${creatorIds})&primary_language=eq.pt`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ primary_language: label, ai_embedded: false }),
    });
    if (!r2.ok) throw new Error(`creators: ${r2.status} ${await r2.text()}`);
    creatorsWritten += (await r2.json()).length;
  }
}
console.log(`\nwritten: ${profilesWritten} social_profiles, ${creatorsWritten} creators`);
