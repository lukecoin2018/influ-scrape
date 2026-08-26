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
 *   - follower: outside MIN..MAX, stamped by direction as out_of_range_high
 *               or out_of_range_low. A follower_count of 0 or null means a
 *               failed or private scrape rather than a small account, and
 *               stays eligible — enrichment re-scrapes counts, so a bad
 *               scrape self-corrects while an exclusion would not.
 *
 * Converges rather than only adding: any profile whose stored import_status
 * differs from the computed one is rewritten, so this also re-labels rows
 * stamped with the earlier undivided 'out_of_range' value.
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
  'social_profiles?select=id,handle,follower_count,creator_id,import_status,import_status_at,enriched_at,intelligence_updated_at' +
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

  // Direction comes from follower_count. An entity hit with an in-range count
  // is filed as 'high': it is an account we do not want in the creator
  // pipelines, and it will never grow into eligibility the way a small
  // account can.
  let desired = 'active';
  if (rangeHit) desired = fc > MAX ? 'out_of_range_high' : 'out_of_range_low';
  else if (entityHit) desired = 'out_of_range_high';

  return { ...p, entityType: entityType ?? '—', entityHit, rangeHit, unknownSize, desired };
});

// Converge: rewrite anything whose stored value differs from the computed one.
const toStamp = rows.filter(r => r.import_status !== r.desired);
const alreadyCorrect = rows.filter(r => r.desired !== 'active' && r.import_status === r.desired);
const keep = rows.filter(r => r.desired === 'active');

console.log('─'.repeat(92));
console.log(`TO STAMP${' '.repeat(58)}${toStamp.length} of ${rows.length}`);
console.log('─'.repeat(92));
for (const r of toStamp) {
  const reason = [
    r.entityHit && `entity (${r.entityHit})`,
    r.rangeHit && (r.follower_count > MAX ? `> ${fmt(MAX)}` : `< ${fmt(MIN)}`),
  ].filter(Boolean).join(' + ');
  const from = r.import_status === 'active' ? '' : ` (was ${r.import_status})`;
  console.log(`  ${fmt(r.follower_count).padStart(11)}  ${r.handle.slice(0, 26).padEnd(28)}${r.desired.padEnd(19)}${reason}${from}`);
}

console.log('\n' + '═'.repeat(92));
console.log(`  entity filter hit      ${rows.filter(r => r.entityHit).length}`
  + `   (${rows.filter(r => r.entityHit && r.rangeHit).length} also out of range)`);
console.log(`  above ${fmt(MAX)}        ${rows.filter(r => r.rangeHit && r.follower_count > MAX).length}`);
console.log(`  below ${fmt(MIN)}         ${rows.filter(r => r.rangeHit && r.follower_count > 0 && r.follower_count < MIN).length}`);
console.log(`  -> out_of_range_high   ${rows.filter(r => r.desired === 'out_of_range_high').length}`);
console.log(`  -> out_of_range_low    ${rows.filter(r => r.desired === 'out_of_range_low').length}`);
console.log(`  TOTAL to write         ${toStamp.length}`
  + (alreadyCorrect.length ? `   (${alreadyCorrect.length} already correct, skipped)` : ''));
console.log(`  staying active         ${keep.length}`
  + `  (${keep.filter(r => r.unknownSize).length} zero/unknown followers, left eligible)`);
const stampedRows = rows.filter(r => r.import_status !== 'active');
const withStamp = stampedRows.filter(r => r.import_status_at);
console.log(`  stamp metadata present ${withStamp.length} of ${stampedRows.length} stamped rows`);
if (withStamp.length) {
  const ages = withStamp.map(r => (Date.now() - new Date(r.import_status_at).getTime()) / 86400000);
  console.log(`    oldest stamp           ${Math.max(...ages).toFixed(1)} days`);
}
console.log(`  already enriched       ${rows.filter(r => r.enriched_at).length}`);
console.log(`  already analysed       ${rows.filter(r => r.intelligence_updated_at).length}`);
console.log('═'.repeat(92));

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }
if (toStamp.length === 0) { console.log('\nAlready converged — nothing to write.'); process.exit(0); }

// 4. Stamp profiles
console.log('\nApplying…');
let stamped = 0;
for (const target of ['out_of_range_high', 'out_of_range_low', 'active']) {
  const ids = toStamp.filter(r => r.desired === target).map(r => r.id);
  for (const batch of chunk(ids, 50)) {
    const inList = batch.map(id => `"${id}"`).join(',');
    const stamped = target !== 'active';
    const r = await fetch(`${U}/rest/v1/social_profiles?id=in.(${inList})`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      // Stamp provenance travels with the status. The follower count snapshot
      // is per-row, so it goes through a returning PATCH per row below rather
      // than this batch write, which can only set one literal value.
      body: JSON.stringify(stamped
        ? { import_status: target, import_status_at: new Date().toISOString() }
        : { import_status: target, import_status_at: null, import_status_follower_count: null }),
    });
    if (!r.ok) throw new Error(`profile update failed: ${await r.text()}`);
    const n = (await r.json()).length;
    stamped += n;
    if (n) console.log(`  social_profiles -> ${target}: ${n}`);
  }
}
console.log(`  social_profiles written: ${stamped}`);

// Snapshot each stamped row's follower count. Separate pass because a batch
// PATCH can only write one literal, and this value differs per row.
let snapshots = 0;
for (const r of toStamp.filter(r => r.desired !== 'active')) {
  const res = await fetch(`${U}/rest/v1/social_profiles?id=eq.${r.id}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ import_status_follower_count: r.follower_count ?? null }),
  });
  if (!res.ok) throw new Error(`snapshot failed for ${r.handle}: ${await res.text()}`);
  snapshots++;
}
console.log(`  follower snapshots:      ${snapshots}`);

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
  // A creator is out only when every profile is; 'high' wins a mixed set,
  // matching rollUpStatuses() in lib/followerRange.ts.
  const targets = new Map();
  for (const [id, statuses] of byCreator.entries()) {
    if (statuses.some(s => s === 'active')) continue;
    targets.set(id, statuses.some(s => s === 'out_of_range_high')
      ? 'out_of_range_high' : 'out_of_range_low');
  }
  for (const target of ['out_of_range_high', 'out_of_range_low']) {
    const ids = [...targets.entries()].filter(([, t]) => t === target).map(([id]) => id);
    if (ids.length === 0) continue;
    const outList = ids.map(id => `"${id}"`).join(',');
    const r = await fetch(`${U}/rest/v1/creators?id=in.(${outList})`, {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ import_status: target }),
    });
    if (!r.ok) throw new Error(`creator roll-up failed: ${await r.text()}`);
    rolled += (await r.json()).length;
  }
}
console.log(`  creators rolled up:      ${rolled}`);
console.log('\nDone. Partnership edges untouched.');
