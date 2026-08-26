#!/usr/bin/env node
/**
 * Recomputes every brand's casting profile from its partnership edges.
 *
 * The brand-feed route refreshes a brand's profile at the end of its own run,
 * but edges also arrive from hashtag sponsorship discovery, which does not.
 * This is the full rebuild: run it after applying the casting migrations, and
 * whenever the band or window changes.
 *
 * Counts distinct creators, not edges, and uses each creator's most recent
 * in-window snapshot. Writes only casting_* columns — never
 * total_partnerships_detected, avg/min/max_partner_follower_count,
 * preferred_creator_tier or active_niches, and never calls
 * recalculate_brand_stats().
 *
 * Usage:
 *   node scripts/backfill-casting-profiles.mjs                     # dry run
 *   node scripts/backfill-casting-profiles.mjs --apply
 *   node scripts/backfill-casting-profiles.mjs --apply --window=180 --min=30000 --max=500000
 */
import fs from 'fs';

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const APPLY = process.argv.includes('--apply');
const WINDOW_DAYS = arg('window', 365);
const MIN = arg('min', 30_000);
const MAX = arg('max', 500_000);
const SAMPLE_FLOOR = arg('floor', 5);

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const U = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' };

const page = async (path, size = 5000) => {
  const out = [];
  for (let from = 0; ; from += size) {
    const r = await fetch(`${U}/rest/v1/${path}`, { headers: { ...H, Range: `${from}-${from + size - 1}` } });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) break;
    out.push(...d);
    if (d.length < size) break;
  }
  return out;
};

console.log(`window ${WINDOW_DAYS}d · band ${MIN.toLocaleString()}–${MAX.toLocaleString()} · sample floor ${SAMPLE_FLOOR}\n`);

const edges = await page('partnerships?select=brand_id,creator_id,creator_follower_count,posted_at,detected_at,follower_count_source&order=id.asc');
const brands = await page('brands?select=id,instagram_handle&order=id.asc');
const nameById = new Map(brands.map(b => [b.id, b.instagram_handle]));

const bySource = edges.reduce((a, e) => { a[e.follower_count_source] = (a[e.follower_count_source] || 0) + 1; return a; }, {});
console.log(`${edges.length} edges — ${JSON.stringify(bySource)}\n`);

const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
const byBrand = new Map();
for (const e of edges) {
  if (!e.brand_id) continue;
  const raw = e.posted_at ?? e.detected_at;
  const at = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(at) || at < cutoff) continue;      // undateable or stale

  if (!byBrand.has(e.brand_id)) byBrand.set(e.brand_id, new Map());
  const latest = byBrand.get(e.brand_id);
  const prev = latest.get(e.creator_id);
  if (!prev || at > prev.at) latest.set(e.creator_id, { at, followers: e.creator_follower_count });
}

const rows = [];
for (const [brandId, latest] of byBrand) {
  const c = { inRange: 0, below: 0, above: 0, unknown: 0, sampleSize: latest.size };
  for (const { followers } of latest.values()) {
    if (followers === null || followers === undefined || followers <= 0) c.unknown++;
    else if (followers < MIN) c.below++;
    else if (followers > MAX) c.above++;
    else c.inRange++;
  }
  rows.push({ brandId, handle: nameById.get(brandId) || brandId.slice(0, 8), ...c });
}

const classified = r => r.inRange + r.below + r.above;
rows.sort((a, b) => b.inRange - a.inRange || b.sampleSize - a.sampleSize);

console.log('  brand                     sample  below  IN-BAND  above  unk   rate');
for (const r of rows.slice(0, 25)) {
  const rate = r.sampleSize >= SAMPLE_FLOOR && classified(r) > 0
    ? `${Math.round(r.inRange / classified(r) * 100)}%`
    : '—';
  console.log(`  ${String(r.handle).slice(0, 24).padEnd(26)}${String(r.sampleSize).padStart(5)}${String(r.below).padStart(7)}${String(r.inRange).padStart(9)}${String(r.above).padStart(7)}${String(r.unknown).padStart(5)}${rate.padStart(7)}`);
}

const ranked = rows.filter(r => r.sampleSize >= SAMPLE_FLOOR).length;
console.log(`\n${rows.length} brands with in-window edges · ${ranked} clear the sample floor of ${SAMPLE_FLOOR}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

console.log('\nWriting…');
let written = 0;
for (const r of rows) {
  const res = await fetch(`${U}/rest/v1/brands?id=eq.${r.brandId}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({
      casting_in_range_count: r.inRange,
      casting_below_count: r.below,
      casting_above_count: r.above,
      casting_unknown_count: r.unknown,
      casting_sample_size: r.sampleSize,
      casting_computed_at: new Date().toISOString(),
      casting_window_days: WINDOW_DAYS,
      casting_min_followers: MIN,
      casting_max_followers: MAX,
    }),
  });
  if (!res.ok) throw new Error(`write failed for ${r.handle}: ${await res.text()}`);
  written++;
}
console.log(`  brands updated: ${written}`);
console.log('\nDone. Only casting_* columns were written.');
