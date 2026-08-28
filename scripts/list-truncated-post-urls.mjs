#!/usr/bin/env node
/**
 * Regenerates the list of TikTok post URLs whose stored brand mentions are
 * corrupted by the display-name truncation bug.
 *
 * Regenerates rather than reading a snapshot: new posts arrive continuously,
 * and a committed list would go stale. See docs/tiktok-truncation-repair.md
 * for the verified repair plan this feeds.
 *
 * Usage:
 *   node scripts/list-truncated-post-urls.mjs
 *   node scripts/list-truncated-post-urls.mjs --out=/path/urls.json
 */
import fs from 'fs';

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=')[1] : d; };
const OUT = arg('out', null);

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const U = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };

/** Keyset pagination — offset paging over 135k creator_posts times out. */
const page = async (t, sel, f = '', size = 1000) => {
  const out = []; let a = '';
  for (;;) {
    const r = await fetch(`${U}/rest/v1/${t}?select=id,${sel}${f ? `&${f}` : ''}&order=id.asc&limit=${size}${a ? `&id=gt.${a}` : ''}`, { headers: H });
    if (!r.ok) throw new Error(await r.text());
    const d = await r.json(); if (!d.length) break;
    out.push(...d); a = d[d.length - 1].id; if (d.length < size) break;
  }
  return out;
};

// detected_brands <> '{}' cannot use an index, so combining it with keyset
// pagination makes every page a wide scan and trips the statement timeout.
// Page on the primary key alone and filter client-side instead.
const allPosts = await page('creator_posts', 'social_profile_id,post_url,caption,detected_brands,posted_at',
  'platform=eq.tiktok');
const posts = allPosts.filter(p => (p.detected_brands || []).length > 0);

// A stored handle is a truncated display name when the caption wrote it
// Capitalised and the next word is Capitalised too: "@Chester Cheetah".
// "@gymshark code LEONI10" is a correct extraction followed by prose.
const affected = posts.filter(p => {
  const cap = p.caption || '';
  return (p.detected_brands || []).some(b => {
    const i = cap.toLowerCase().indexOf('@' + b);
    if (i === -1) return false;
    return /^[A-ZÀ-Þ]/.test(cap.slice(i + 1, i + 1 + b.length))
        && /^[ '’\-][A-ZÀ-Þ]/.test(cap.slice(i + 1 + b.length));
  });
}).filter(p => /^https:\/\/www\.tiktok\.com\/@[A-Za-z0-9._]+\/video\/\d+$/.test(p.post_url || ''));

const now = Date.now(), D = 86400000;
const bands = { '<2mo': 0, '2-6mo': 0, '6-12mo': 0, '>12mo': 0 };
for (const p of affected) {
  const a = (now - new Date(p.posted_at)) / D;
  bands[a < 60 ? '<2mo' : a < 180 ? '2-6mo' : a < 365 ? '6-12mo' : '>12mo']++;
}

console.log(`${allPosts.length} TikTok posts scanned, ${posts.length} carry brand mentions`);
console.log(`${affected.length} carry an unrecoverable truncation and have a usable URL\n`);
console.log('age distribution:');
for (const [b, n] of Object.entries(bands)) console.log(`  ${b.padEnd(8)} ${String(n).padStart(5)}  ${Math.round(n / affected.length * 100)}%`);
console.log(`\ncost at $0.003/result (FREE tier): $${(affected.length * 0.003).toFixed(2)}`);

const rows = affected.map(p => ({ id: p.id, url: p.post_url, socialProfileId: p.social_profile_id, postedAt: p.posted_at }));
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(rows, null, 1)); console.log(`\n${rows.length} rows -> ${OUT}`); }
else console.log('\npass --out=<file> to write the list');
