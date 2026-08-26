#!/usr/bin/env node
/**
 * Backfills brands.mention_platforms and brands.tiktok_handle from the
 * platform of the posts each brand was actually detected in.
 *
 * Provenance is creator_posts.platform — the post that produced the mention —
 * not a guess from the handle. A brand mentioned only in TikTok posts gets
 * {tiktok}; one seen on both gets {instagram,tiktok} and both handle columns,
 * which is the normal case for a brand running accounts on each.
 *
 * instagram_handle is never modified. It is the identity key for brands and
 * the join key for brand_aliases.
 *
 * Also reports brand_aliases rows whose alias is not a legal username — brand
 * NAMES lifted out of caption prose by the old TikTok mention regex.
 *
 * Usage:
 *   node scripts/backfill-brand-platforms.mjs            # dry run
 *   node scripts/backfill-brand-platforms.mjs --apply
 */
import fs from 'fs';

const APPLY = process.argv.includes('--apply');
const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const U = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' };

/**
 * Keyset pagination on id.
 *
 * Offset paging re-scans from the top on every page, and the
 * detected_brands <> '{}' predicate cannot use an index — over 135k
 * creator_posts that hits the statement timeout partway through. Seeking on
 * the last id read keeps every page a bounded range scan.
 */
const page = async (table, select, filter = '', size = 1000) => {
  const out = [];
  let after = '';
  for (;;) {
    const url = `${U}/rest/v1/${table}?select=id,${select}` +
      (filter ? `&${filter}` : '') +
      `&order=id.asc&limit=${size}` +
      (after ? `&id=gt.${after}` : '');
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) break;
    out.push(...d);
    after = d[d.length - 1].id;
    if (d.length < size) break;
  }
  return out;
};
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const validHandle = h => h.length >= 2 && h.length <= 30 && /^[a-z0-9._]+$/.test(h) && !/^\d+$/.test(h);

// 1. Attribute every brand mention to the platform of the post it came from.
const posts = await page('creator_posts', 'platform,detected_brands', 'detected_brands=neq.%7B%7D');
const seen = new Map();                       // handle -> { instagram: n, tiktok: n }
for (const p of posts) {
  const plat = p.platform === 'tiktok' ? 'tiktok' : 'instagram';
  for (const raw of p.detected_brands || []) {
    const h = String(raw).trim().toLowerCase().replace(/^@/, '');
    if (!h) continue;
    if (!seen.has(h)) seen.set(h, { instagram: 0, tiktok: 0 });
    seen.get(h)[plat]++;
  }
}
console.log(`${posts.length} posts with mentions -> ${seen.size} distinct handles\n`);

// 2. Map onto brands rows.
// Preflight: the new columns are applied by hand. Without them the analysis
// below is still worth printing, so report rather than crash.
const probe = await fetch(`${U}/rest/v1/brands?select=tiktok_handle&limit=1`, { headers: H });
const MIGRATED = probe.ok;
if (!MIGRATED) {
  console.log('!! migration 20260826000006 not applied — analysis only, nothing can be written.\n');
}

const brands = MIGRATED
  ? await page('brands', 'instagram_handle,tiktok_handle,mention_platforms')
  : (await page('brands', 'instagram_handle')).map(b => ({ ...b, tiktok_handle: null, mention_platforms: null }));
const updates = [];
let unmentioned = 0;
for (const b of brands) {
  const h = String(b.instagram_handle || '').toLowerCase();
  const e = seen.get(h);
  if (!e) { unmentioned++; continue; }

  const platforms = [];
  if (e.instagram > 0) platforms.push('instagram');
  if (e.tiktok > 0) platforms.push('tiktok');

  const wantTikTok = e.tiktok > 0 ? (b.tiktok_handle || h) : b.tiktok_handle;
  const same = JSON.stringify(b.mention_platforms || []) === JSON.stringify(platforms)
    && (b.tiktok_handle || null) === (wantTikTok || null);
  if (same) continue;

  updates.push({ id: b.id, handle: h, platforms, tiktok_handle: wantTikTok || null, ...e });
}

const tally = updates.reduce((a, u) => { a[u.platforms.join('+') || 'none']++ || (a[u.platforms.join('+') || 'none'] = 1); return a; }, {});
console.log('=== brands to update ===');
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(20)} ${v}`);
console.log(`  ${'(no mentions, skipped)'.padEnd(20)} ${unmentioned}`);

const ttOnly = updates.filter(u => u.platforms.length === 1 && u.platforms[0] === 'tiktok');
console.log(`\n=== TikTok-only: the brands the Instagram sweep should skip (${ttOnly.length}) ===`);
for (const u of ttOnly.sort((a, b) => b.tiktok - a.tiktok).slice(0, 15)) {
  console.log(`  ${u.handle.padEnd(26)} TT ${String(u.tiktok).padStart(3)}  IG 0${validHandle(u.handle) ? '' : '   <- not a legal handle'}`);
}

// 3. Malformed aliases — the cleanup question.
const aliases = await (async () => {
  const out = []; let after = '';
  for (;;) {
    const url = `${U}/rest/v1/brand_aliases?select=alias,canonical_name,entity_type,verified,creators_count&order=alias.asc&limit=2000` + (after ? `&alias=gt.${encodeURIComponent(after)}` : '');
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json();
    if (!d.length) break;
    out.push(...d); after = d[d.length - 1].alias;
    if (d.length < 2000) break;
  }
  return out;
})();
const bad = aliases.filter(a => !validHandle(String(a.alias).toLowerCase()));
console.log(`\n=== malformed brand_aliases (brand NAMES, not handles) ===`);
console.log(`  ${bad.length} of ${aliases.length} alias rows`);
const byType = bad.reduce((a, r) => { a[r.entity_type] = (a[r.entity_type] || 0) + 1; return a; }, {});
console.log('  by entity_type:', JSON.stringify(byType));
console.log(`  verified: ${bad.filter(r => r.verified).length}   with creators_count >= 2: ${bad.filter(r => (r.creators_count || 0) >= 2).length}`);
console.log('  worst offenders:');
for (const r of bad.sort((a, b) => (b.creators_count || 0) - (a.creators_count || 0)).slice(0, 12)) {
  console.log(`    ${String(r.alias).slice(0, 28).padEnd(30)} ${String(r.entity_type).padEnd(10)} creators=${String(r.creators_count ?? 0).padStart(3)}  ${r.canonical_name || ''}`);
}

if (!MIGRATED) {
  console.log(`\nApply migration 20260826000006, then re-run. ${updates.length} brands are ready to be classified.`);
  process.exit(0);
}
if (!APPLY) { console.log(`\nDRY RUN — ${updates.length} brands would be updated. Re-run with --apply.`); process.exit(0); }

console.log(`\nApplying to ${updates.length} brands…`);
let written = 0;
for (const batch of chunk(updates, 1)) {
  for (const u of batch) {
    const body = { mention_platforms: u.platforms };
    if (u.tiktok_handle) body.tiktok_handle = u.tiktok_handle;
    const r = await fetch(`${U}/rest/v1/brands?id=eq.${u.id}`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`update failed for ${u.handle}: ${await r.text()}`);
    written++;
    if (written % 500 === 0) console.log(`  ${written}/${updates.length}`);
  }
}
console.log(`  brands updated: ${written}`);
console.log('\nDone. instagram_handle was not modified.');
