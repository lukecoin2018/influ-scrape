#!/usr/bin/env node
/**
 * One-off retroactive cleanup for the first brand-feed test cohort.
 *
 * The 25-brand test run on 2026-08-25 imported 119 Instagram profiles before
 * the entity and follower-range filters existed. This applies those same two
 * filters after the fact, so the cohort matches what the import path would
 * produce today.
 *
 * Deliberately NOT a migration: it is a data correction for one known cohort,
 * not a schema change, and it must never re-run as part of a deploy. The
 * cohort is identified by discovered_via_hashtags @> {brand_feed}, which the
 * brand-feed importer stamps on every profile it creates.
 *
 * Filters, matching app/api/brand-feed/process/route.ts:
 *   - entity:   brand_aliases.entity_type in (brand, celebrity, media, venue,
 *               fragment), or a brands row with data_source
 *               'sponsorship_detection'. Other brands rows are NOT trusted —
 *               11,402 of them are enrich-pipeline stubs that include real
 *               creators.
 *   - follower: outside MIN..MAX. A follower_count of 0 or null means a failed
 *               or private scrape rather than a small account, and stays
 *               eligible — enrichment re-scrapes counts, so a bad scrape
 *               self-corrects while an exclusion would not.
 *
 * Partnership edges are never touched: an out-of-range creator keeps their
 * brand relationships, they are just excluded from the spend pipelines.
 *
 * Usage:
 *   node scripts/cleanup-brand-feed-cohort.mjs           # dry run
 *   node scripts/cleanup-brand-feed-cohort.mjs --apply   # write
 */
import fs from 'fs';

const APPLY = process.argv.includes('--apply');
const MIN = 30_000, MAX = 500_000;
const NON_CREATOR_ENTITY_TYPES = ['brand', 'celebrity', 'media', 'venue', 'fragment'];
const TRUSTED_BRAND_DATA_SOURCES = ['sponsorship_detection'];

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const U = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
if (!U || !K) { console.error('Missing Supabase credentials in .env.local'); process.exit(1); }

const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' };
const get = async (path) => {
  const r = await fetch(`${U}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path.slice(0, 60)} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const fmt = n => (n ?? 0).toLocaleString();

// 1. Cohort
const cohort = await get(
  'social_profiles?select=id,handle,follower_count,creator_id,import_status,enriched_at,intelligence_updated_at' +
  '&platform=eq.instagram&discovered_via_hashtags=cs.%7Bbrand_feed%7D&order=follower_count.desc'
);
console.log(`Cohort: ${cohort.length} profiles imported by the brand-feed pipeline\n`);
if (cohort.length === 0) { console.log('Nothing to do.'); process.exit(0); }

// 2. Entity classification from both sources
const aliasByHandle = new Map(), trustedBrand = new Set();
for (const batch of chunk(cohort.map(p => p.handle), 100)) {
  const inList = batch.map(h => `"${h}"`).join(',');
  for (const a of await get(`brand_aliases?select=alias,entity_type&alias=in.(${inList})`)) {
    aliasByHandle.set(a.alias.toLowerCase(), a.entity_type);
  }
  for (const b of await get(
    `brands?select=instagram_handle,data_source&instagram_handle=in.(${inList})` +
    `&data_source=in.(${TRUSTED_BRAND_DATA_SOURCES.map(s => `"${s}"`).join(',')})`
  )) {
    trustedBrand.add(String(b.instagram_handle).toLowerCase());
  }
}

// 3. Classify
const rows = cohort.map(p => {
  const h = p.handle.toLowerCase();
  const entityType = aliasByHandle.get(h);
  const entityHit = (entityType && NON_CREATOR_ENTITY_TYPES.includes(entityType))
    ? `alias:${entityType}`
    : trustedBrand.has(h) ? 'brands:sponsorship_detection' : null;
  const fc = p.follower_count;
  const unknownSize = fc === null || fc === undefined || fc <= 0;
  const rangeHit = !unknownSize && (fc < MIN || fc > MAX);
  return { ...p, entityType: entityType ?? '—', entityHit, rangeHit, unknownSize, stamp: Boolean(entityHit || rangeHit) };
});

const toStamp = rows.filter(r => r.stamp && r.import_status !== 'out_of_range');
const alreadyStamped = rows.filter(r => r.stamp && r.import_status === 'out_of_range');
const keep = rows.filter(r => !r.stamp);

console.log('─'.repeat(92));
console.log(`TO STAMP out_of_range${' '.repeat(45)}${toStamp.length} of ${rows.length}`);
console.log('─'.repeat(92));
for (const r of toStamp) {
  const reason = [
    r.entityHit && `entity (${r.entityHit})`,
    r.rangeHit && (r.follower_count > MAX ? `> ${fmt(MAX)}` : `< ${fmt(MIN)}`),
  ].filter(Boolean).join(' + ');
  console.log(`  ${fmt(r.follower_count).padStart(11)}  ${r.handle.slice(0, 28).padEnd(30)}${String(r.entityType).padEnd(12)}${reason}`);
}

console.log('\n' + '═'.repeat(92));
console.log(`  entity filter hit      ${rows.filter(r => r.entityHit).length}`
  + `   (${rows.filter(r => r.entityHit && r.rangeHit).length} also out of range)`);
console.log(`  above ${fmt(MAX)}        ${rows.filter(r => r.rangeHit && r.follower_count > MAX).length}`);
console.log(`  below ${fmt(MIN)}         ${rows.filter(r => r.rangeHit && r.follower_count > 0 && r.follower_count < MIN).length}`);
console.log(`  TOTAL to stamp         ${toStamp.length}`
  + (alreadyStamped.length ? `   (${alreadyStamped.length} already stamped, skipped)` : ''));
console.log(`  staying active         ${keep.length}`
  + `  (${keep.filter(r => r.unknownSize).length} zero/unknown followers, left eligible)`);
console.log(`  already enriched       ${rows.filter(r => r.enriched_at).length}`);
console.log(`  already analysed       ${rows.filter(r => r.intelligence_updated_at).length}`);
console.log('═'.repeat(92));

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }
if (toStamp.length === 0) { console.log('\nNothing left to stamp.'); process.exit(0); }

// 4. Stamp profiles
console.log('\nApplying…');
let stamped = 0;
for (const batch of chunk(toStamp.map(r => r.id), 50)) {
  const inList = batch.map(id => `"${id}"`).join(',');
  const r = await fetch(`${U}/rest/v1/social_profiles?id=in.(${inList})`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ import_status: 'out_of_range' }),
  });
  if (!r.ok) throw new Error(`profile update failed: ${await r.text()}`);
  stamped += (await r.json()).length;
}
console.log(`  social_profiles stamped: ${stamped}`);

// 5. Roll up — a creator is out only when ALL their profiles are out
const creatorIds = [...new Set(toStamp.map(r => r.creator_id))].filter(Boolean);
let rolled = 0;
for (const batch of chunk(creatorIds, 50)) {
  const inList = batch.map(id => `"${id}"`).join(',');
  const profiles = await get(`social_profiles?select=creator_id,import_status&creator_id=in.(${inList})`);
  const byCreator = new Map();
  for (const p of profiles) {
    if (!byCreator.has(p.creator_id)) byCreator.set(p.creator_id, []);
    byCreator.get(p.creator_id).push(p.import_status);
  }
  const allOut = [...byCreator.entries()]
    .filter(([, statuses]) => statuses.every(s => s === 'out_of_range'))
    .map(([id]) => id);
  if (allOut.length === 0) continue;
  const outList = allOut.map(id => `"${id}"`).join(',');
  const r = await fetch(`${U}/rest/v1/creators?id=in.(${outList})`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ import_status: 'out_of_range' }),
  });
  if (!r.ok) throw new Error(`creator roll-up failed: ${await r.text()}`);
  rolled += (await r.json()).length;
}
console.log(`  creators rolled up:      ${rolled}`);
console.log('\nDone. Partnership edges untouched.');
