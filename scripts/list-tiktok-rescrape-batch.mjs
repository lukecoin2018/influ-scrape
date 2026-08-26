#!/usr/bin/env node
/**
 * Lists the TikTok creators whose stored brand mentions are corrupted by the
 * display-name truncation bug, so they can be re-enriched with the fixed
 * extractor.
 *
 * Why a re-scrape and not a recompute: creator_posts stores the caption but
 * never stored the actor's resolved detailedMentions/mentions. TikTok captions
 * render "@Huda Beauty", so the caption alone cannot recover "hudabeauty".
 * Only 5% of truncations (the accent/apostrophe class) are fixable from stored
 * text; the other 95% need the actor's fields, which means scraping again.
 *
 * The re-scrape doubles as a re-enrichment: engagement metrics, posting
 * frequency and content mix all refresh on the same pass.
 *
 * Output is batched for the Enrich page's "Specific creators" mode. Set
 * platform to TikTok and Posts Per Creator to 15.
 *
 * Usage:
 *   node scripts/list-tiktok-rescrape-batch.mjs
 *   node scripts/list-tiktok-rescrape-batch.mjs --batch=150 --out=/tmp/batches.txt
 */
import fs from 'fs';

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=')[1] : d; };
const BATCH = Number(arg('batch', 150));
const OUT = arg('out', null);

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const U = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };

/** Keyset pagination — offset paging over 135k creator_posts times out. */
const page = async (table, select, filter = '', size = 1000) => {
  const out = []; let after = '';
  for (;;) {
    const url = `${U}/rest/v1/${table}?select=id,${select}${filter ? `&${filter}` : ''}` +
      `&order=id.asc&limit=${size}${after ? `&id=gt.${after}` : ''}`;
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const d = await r.json();
    if (!d.length) break;
    out.push(...d); after = d[d.length - 1].id;
    if (d.length < size) break;
  }
  return out;
};

const posts = await page('creator_posts', 'social_profile_id,caption,detected_brands',
  'platform=eq.tiktok&detected_brands=neq.%7B%7D');

// A stored brand handle is a truncated display name when the caption wrote it
// Capitalised and the next word is also Capitalised: "@Huda Beauty".
// "@gymshark code LEONI10" is a correct extraction followed by prose.
const affected = new Map();
for (const p of posts) {
  const cap = p.caption || '';
  for (const b of p.detected_brands || []) {
    const i = cap.toLowerCase().indexOf('@' + b);
    if (i === -1) continue;
    const written = cap.slice(i + 1, i + 1 + b.length);
    if (!/^[A-ZÀ-Þ]/.test(written)) continue;
    if (!/^[ '’\-][A-ZÀ-Þ]/.test(cap.slice(i + 1 + b.length))) continue;
    affected.set(p.social_profile_id, (affected.get(p.social_profile_id) || 0) + 1);
  }
}

const profiles = await page('social_profiles', 'handle,follower_count', 'platform=eq.tiktok');
const rows = profiles
  .filter(p => affected.has(p.id))
  .map(p => ({ handle: p.handle, hits: affected.get(p.id), followers: p.follower_count || 0 }))
  .sort((a, b) => b.hits - a.hits);

const results = rows.length * 15;
console.log(`${posts.length} TikTok posts with brand mentions`);
console.log(`${rows.length} creators carry at least one truncated mention\n`);
console.log(`re-scrape at 15 posts each = ${results.toLocaleString()} results`);
console.log(`  FREE  $${(results * 0.003).toFixed(2)}`);
console.log(`  BRONZE $${(results * 0.002).toFixed(2)}`);
console.log(`  GOLD  $${(results * 0.001).toFixed(2)}`);
console.log(`\nEnrich page -> platform TikTok, mode "Specific creators", Posts Per Creator 15.`);
console.log(`${Math.ceil(rows.length / BATCH)} batches of ${BATCH}:\n`);

const lines = [];
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  lines.push(`--- batch ${Math.floor(i / BATCH) + 1} (${batch.length}) ---`);
  lines.push(batch.map(r => r.handle).join(' '));
  lines.push('');
}
const text = lines.join('\n');
if (OUT) { fs.writeFileSync(OUT, text); console.log(`written to ${OUT}`); }
else console.log(text.split('\n').slice(0, 6).join('\n') + '\n  … pass --out=<file> for the full list');
