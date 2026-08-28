#!/usr/bin/env node
/**
 * TikTok truncation repair. See docs/tiktok-truncation-repair.md.
 *
 * TikTok captions render mentions as @DisplayName, so the old caption-parsing
 * extractor stored "chester" where the account is actually "cheetos". This
 * re-scrapes the affected posts BY URL — feed scraping would fetch a
 * creator's most recent posts, not the posts carrying the truncations, and
 * 59% of them are older than two months.
 *
 * Rewrites ONLY tagged_accounts, detected_brands, sponsor_signals and
 * is_sponsored on the existing creator_posts rows, by id. It never uses the
 * enrich upsert path (which would overwrite captions and metrics) and never
 * advances social_profiles.enriched_at — this is a repair, not a
 * re-enrichment.
 *
 * Run scripts/list-truncated-post-urls.mjs first to produce the target list;
 * regenerate rather than reusing a snapshot, since new posts keep arriving.
 *
 * Usage:
 *   node scripts/repair-tiktok-truncations.mjs --urls=/tmp/urls.json
 *   node scripts/repair-tiktok-truncations.mjs --urls=/tmp/urls.json --limit=50
 *   node scripts/repair-tiktok-truncations.mjs --urls=/tmp/urls.json --apply
 *
 * Batch first and check the report before running the rest.
 */
import fs from 'fs';
import { createRequire } from 'module';
import { buildLibs } from './_build-libs.mjs';

const require = createRequire(process.cwd() + '/node_modules/');
const LIBS = buildLibs();
const { detectBrandsInPost } = require(`${LIBS}/brandDetection.js`);
const { handlesFromActorList, extractMentionsFromCaption } = require(`${LIBS}/handles.js`);
const arg = (n,d)=>{const h=process.argv.find(a=>a.startsWith(`--${n}=`));return h?h.split('=')[1]:d;};
const BATCH  = Number(arg('batch', 50));
const OFFSET = Number(arg('offset', 0));
// -1 means "no limit". 0 previously meant that too, which made a mistyped
// --limit=0 scrape the entire target list instead of nothing.
const LIMIT  = Number(arg('limit', -1));
const APPLY  = process.argv.includes('--apply');

const env = Object.fromEntries(fs.readFileSync('.env.local','utf8')
  .split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
const U = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY, T = env.APIFY_API_TOKEN;
const H = { apikey:K, Authorization:`Bearer ${K}`, 'Content-Type':'application/json' };

const URLS = arg('urls', '/tmp/repair_urls.json');
const targets = JSON.parse(fs.readFileSync(URLS,'utf8'));
const slice = targets.slice(OFFSET, LIMIT >= 0 ? OFFSET + LIMIT : undefined);
console.log(`${targets.length} targets total; processing ${slice.length} from offset ${OFFSET} in batches of ${BATCH}`);
console.log(APPLY ? 'MODE: APPLY (writes)\n' : 'MODE: DRY RUN (no writes)\n');

const chunk=(a,n)=>{const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;};
const norm=s=>String(s??'').trim().toLowerCase().replace(/^@/,'');

const totals = { scraped:0, returned:0, missing:0, errored:0, updated:0, unchanged:0,
                 fragmentsRemoved:0, handlesAdded:0, dupPairs:0, cost:0 };
const removedSample = [], addedSample = [], dupSample = [];

for (const [bi, batch] of chunk(slice, BATCH).entries()) {
  const label = `batch ${bi+1}/${Math.ceil(slice.length/BATCH)}`;
  // Current DB state for these rows
  const inList = batch.map(t=>`"${t.id}"`).join(',');
  const rows = await (await fetch(`${U}/rest/v1/creator_posts?select=id,post_url,caption,hashtags,tagged_accounts,detected_brands,post_type&id=in.(${inList})`,{headers:H})).json();
  const byId = new Map(rows.map(r=>[r.id,r]));

  // Scrape
  const start = await fetch(`https://api.apify.com/v2/acts/clockworks~tiktok-video-scraper/runs?token=${T}`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ postURLs: batch.map(t=>t.url), shouldDownloadVideos:false, shouldDownloadCovers:false, shouldDownloadSlideshowImages:false }),
  });
  if(!start.ok){ console.error(`${label}: start failed`, await start.text()); break; }
  const runId=(await start.json()).data.id;
  let run;
  for(let i=0;i<150;i++){ await new Promise(r=>setTimeout(r,4000));
    const s=await(await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${T}`)).json();
    if(s.data.status==='SUCCEEDED'){run=s.data;break;}
    if(['FAILED','ABORTED','TIMED-OUT'].includes(s.data.status)){console.error(`${label}: run ${s.data.status}`);break;} }
  if(!run){ console.error(`${label}: no successful run`); break; }
  const items = await (await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${T}&clean=true`)).json();
  totals.scraped += batch.length; totals.returned += items.length; totals.cost += items.length*0.003;

  const byUrl = new Map();
  for (const it of items) {
    const u = it.webVideoUrl || it.submittedVideoUrl;
    if (u) byUrl.set(String(u).split('?')[0], it);
  }

  let bUpdated=0, bMissing=0, bErrored=0, bFrag=0, bAdd=0;
  for (const t of batch) {
    const row = byId.get(t.id); if(!row) continue;
    const it = byUrl.get(t.url);
    if (!it) { bMissing++; totals.missing++; continue; }
    if (it.error || it.errorCode) { bErrored++; totals.errored++; continue; }

    // detailedMentions outright; mentions only if that field is absent.
    const hasResolved = Array.isArray(it.detailedMentions);
    const tagged = hasResolved ? handlesFromActorList(it.detailedMentions)
                 : Array.isArray(it.mentions) ? handlesFromActorList(it.mentions)
                 : extractMentionsFromCaption(it.text || row.caption || '');
    const taggedAccounts = [...new Set(tagged)];

    const hashtags = [...new Set([
      ...(Array.isArray(it.hashtags)?it.hashtags:[]).map(h=>typeof h==='string'?h:h?.name||'').filter(Boolean).map(h=>h.toLowerCase().replace(/^#/,'')),
      ...(row.hashtags||[]),
    ])];

    const det = detectBrandsInPost({
      ownerUsername: norm(it.authorMeta?.name),
      caption: it.text || row.caption || '',
      hashtags, taggedAccounts,
      // The whole point of the repair: with resolved mentions the detector
      // must not re-parse the caption, or "chester" comes back beside
      // "cheetos" on the same post.
      mentionsAreResolved: hasResolved,
      url: it.webVideoUrl || row.post_url || '', type: 'video',
    });

    const before = [...(row.detected_brands||[])].sort();
    const after  = [...det.brandHandles].sort();
    const removed = before.filter(b=>!after.includes(b));
    const added   = after.filter(b=>!before.includes(b));
    bFrag += removed.length; bAdd += added.length;
    totals.fragmentsRemoved += removed.length; totals.handlesAdded += added.length;
    if (removedSample.length < 12 && removed.length) removedSample.push(`${removed.join(',')} -> ${added.join(',')||'(none)'}`);
    // A fragment surviving next to the handle it is a broken version of.
    for (const a of after) for (const b of after)
      if (a !== b && a.length < b.length && b.startsWith(a)) {
        totals.dupPairs++;
        if (dupSample.length < 8) dupSample.push(`${a} + ${b}   tagged=[${taggedAccounts.join(',')}]  caption="${(it.text||'').slice(0,60).replace(/\n/g,' ')}"`);
      }

    if (JSON.stringify(before)===JSON.stringify(after) &&
        JSON.stringify([...(row.tagged_accounts||[])].sort())===JSON.stringify([...taggedAccounts].sort())) {
      totals.unchanged++; continue;
    }

    if (APPLY) {
      const res = await fetch(`${U}/rest/v1/creator_posts?id=eq.${t.id}`,{
        method:'PATCH', headers:{...H, Prefer:'return=minimal'},
        body: JSON.stringify({
          tagged_accounts: taggedAccounts,
          detected_brands: det.brandHandles,
          sponsor_signals: det.detectionSignals,
          is_sponsored: det.isSponsoredContent,
        }),
      });
      if(!res.ok){ console.error(`  PATCH failed ${t.id}:`, await res.text()); continue; }
    }
    bUpdated++; totals.updated++;
  }
  console.log(`${label}: scraped ${batch.length}, returned ${items.length}, updated ${bUpdated}, missing ${bMissing}, errored ${bErrored}, fragments -${bFrag} +${bAdd}`);
}

console.log('\n=== TOTALS ===');
console.log(`  posts attempted        : ${totals.scraped}`);
console.log(`  items returned         : ${totals.returned}`);
console.log(`  rows updated           : ${totals.updated}`);
console.log(`  unchanged (no drift)   : ${totals.unchanged}`);
console.log(`  missing from response  : ${totals.missing}`);
console.log(`  actor errors           : ${totals.errored}`);
const lost = totals.missing + totals.errored;
console.log(`  resolution rate        : ${((totals.scraped-lost)/totals.scraped*100).toFixed(1)}%  (probe measured 100%)`);
console.log(`  fragment handles removed: ${totals.fragmentsRemoved}`);
console.log(`  real handles added      : ${totals.handlesAdded}`);
console.log(`  prefix-duplicate pairs  : ${totals.dupPairs}  (e.g. ruffles beside officialruffles — must be 0)`);
console.log(`  cost                    : $${totals.cost.toFixed(2)}`);
if (removedSample.length) { console.log('\n  sample replacements:'); removedSample.forEach(s=>console.log('    '+s)); }
if (dupSample.length) { console.log('\n  prefix-duplicate detail:'); dupSample.forEach(s=>console.log('    '+s)); }
