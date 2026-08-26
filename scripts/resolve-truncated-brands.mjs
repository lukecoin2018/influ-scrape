#!/usr/bin/env node
/**
 * Resolves truncated brand fragments back to real handles.
 *
 * TikTok captions render "@Hourglass Cosmetics"; the old extractor stored the
 * fragment "hourglass". Those fragments reached brand_aliases and are
 * classified as verified brands, so the real Instagram accounts behind them —
 * hourglasscosmetics, narsissist, ultabeauty — are invisible to the sweep.
 *
 * This recovers the full display name that followed each fragment in the
 * captions, derives a candidate handle from it, and checks that candidate
 * against handles already held in brands and social_profiles.
 *
 * Read-only. It produces a review list, not a migration: the candidate is a
 * proposal and some resolve back to the fragment itself (a brand whose real
 * handle genuinely IS the short word, like morphe or dove), which only a human
 * or a profile lookup can tell apart.
 *
 * Usage:
 *   node scripts/resolve-truncated-brands.mjs
 *   node scripts/resolve-truncated-brands.mjs --top=50 --json=/tmp/out.json
 */
import fs from 'fs';

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=')[1] : d; };
const TOP = Number(arg('top', 50));
const JSON_OUT = arg('json', null);
const MIN_TRUNCATION_RATE = 0.8;

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const U = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };

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
const allAliases = async () => {
  const o = []; let a = '';
  for (;;) {
    const r = await fetch(`${U}/rest/v1/brand_aliases?select=alias,canonical_name,entity_type,verified,creators_count&order=alias.asc&limit=2000${a ? `&alias=gt.${encodeURIComponent(a)}` : ''}`, { headers: H });
    const d = await r.json(); if (!d.length) break;
    o.push(...d); a = d[d.length - 1].alias; if (d.length < 2000) break;
  }
  return o;
};

const posts = await page('creator_posts', 'caption,detected_brands', 'platform=eq.tiktok&detected_brands=neq.%7B%7D');

const evidence = new Map();   // fragment -> { trunc, clean, names: Map }
for (const p of posts) {
  const cap = p.caption || '';
  for (const b of p.detected_brands || []) {
    const i = cap.toLowerCase().indexOf('@' + b);
    if (i === -1) continue;
    if (!evidence.has(b)) evidence.set(b, { trunc: 0, clean: 0, names: new Map() });
    const e = evidence.get(b);
    const written = cap.slice(i + 1, i + 1 + b.length);
    const rest = cap.slice(i + 1 + b.length);
    const isTrunc = /^[A-ZÀ-Þ]/.test(written) && /^[ '’\-][A-ZÀ-Þ]/.test(rest);
    if (!isTrunc) { e.clean++; continue; }
    e.trunc++;
    const m = rest.match(/^[ '’\-]([A-ZÀ-Þ][A-Za-zÀ-ÿ]*(?:[ '’\-][A-ZÀ-Þ][A-Za-zÀ-ÿ]*)*)/);
    if (m) {
      const full = `${written} ${m[1]}`.replace(/\s+/g, ' ').trim();
      e.names.set(full, (e.names.get(full) || 0) + 1);
    }
  }
}

const aliases = await allAliases();
const aliasBy = new Map(aliases.map(a => [a.alias.toLowerCase(), a]));
const brandSet = new Set((await page('brands', 'instagram_handle')).map(b => String(b.instagram_handle || '').toLowerCase()));
const igSet = new Set((await page('social_profiles', 'handle', 'platform=eq.instagram')).map(p => String(p.handle || '').toLowerCase()));

const rows = [];
for (const [fragment, e] of evidence) {
  if (!e.names.size) continue;
  const rate = e.trunc / (e.trunc + e.clean);
  if (rate < MIN_TRUNCATION_RATE) continue;

  const full = [...e.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const slug = full.toLowerCase().replace(/[^a-z0-9]/g, '');
  const trimmed = slug.replace(/(cosmetics|beauty|official|skincare)$/, '');
  const guesses = [...new Set([slug, trimmed])].filter(g => g.length >= 3 && g.length <= 30);

  const known = guesses.find(g => brandSet.has(g) || igSet.has(g)) || null;
  const a = aliasBy.get(fragment);
  rows.push({
    fragment, displayName: full, proposed: slug,
    // Self-referential: the candidate collapsed back to the fragment, so the
    // short word may genuinely be the real handle (morphe, dove).
    selfReferential: known === fragment,
    knownHandle: known,
    aliasType: a?.entity_type ?? null,
    aliasVerified: a?.verified ?? false,
    creatorsCount: a?.creators_count ?? 0,
    truncatedMentions: e.trunc,
  });
}
rows.sort((a, b) => b.creatorsCount - a.creatorsCount || b.truncatedMentions - a.truncatedMentions);

const resolved = rows.filter(r => r.knownHandle && !r.selfReferential);
const selfRef = rows.filter(r => r.selfReferential);
console.log(`=== ${rows.length} fragments at >=${MIN_TRUNCATION_RATE * 100}% truncation with a recoverable display name ===`);
console.log(`  resolve to a handle already held : ${resolved.length}`);
console.log(`  candidate collapses to the fragment (may already be correct) : ${selfRef.length}`);
console.log(`  no match — needs a lookup         : ${rows.length - resolved.length - selfRef.length}\n`);
console.log(`  top ${TOP} by creators_count:\n`);
console.log('  fragment        display name              proposed handle          status        creators');
for (const r of rows.slice(0, TOP)) {
  const status = r.selfReferential ? 'self-ref' : r.knownHandle ? 'KNOWN' : 'lookup';
  console.log(`  ${r.fragment.slice(0, 14).padEnd(16)}${r.displayName.slice(0, 24).padEnd(26)}${(r.knownHandle || r.proposed).slice(0, 22).padEnd(25)}${status.padEnd(14)}${r.creatorsCount}`);
}
if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1)); console.log(`\nfull list -> ${JSON_OUT} (${rows.length} rows)`); }
