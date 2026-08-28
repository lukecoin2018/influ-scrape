#!/usr/bin/env node
/**
 * Tests for the shared brand-detection logic.
 *
 * Plain node, no test framework — the project has none, and adding one for
 * a single suite would be a heavier decision than it deserves. Run with:
 *
 *   node scripts/test-detection.mjs
 *
 * Exits non-zero on failure, so it works in CI as-is.
 */
import { createRequire } from 'module';
import { buildLibs } from './_build-libs.mjs';

const require = createRequire(process.cwd() + '/node_modules/');
const { detectBrandsInPost } = require(`${buildLibs()}/brandDetection.js`);

let pass = 0, fail = 0;
const eq = (n, a, e) => {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got  ${JSON.stringify(a)}\n       want ${JSON.stringify(e)}`); }
};
const post = o => ({ ownerUsername:'creator', caption:'', hashtags:[], taggedAccounts:[], url:'u', type:'video', ...o });
const brands = o => detectBrandsInPost(post(o)).brandHandles.sort();
const sig = o => detectBrandsInPost(post(o)).detectionSignals.sort();

// The canonical case. Verified against a live scrape of this exact post
// (Apify run sfQmsqa3UzY08rZHL): the caption says "@Chester Cheetah", the
// actor's detailedMentions say the account is "cheetos".
const chester = {
  caption: '#ad Early access to the flavor swap bundle from Frito-Lay is finally available and it’s worth the hype! @Chester Cheetah @Doritos @RUFFLES #flavorswap #snacktok',
  hashtags: ['ad','flavorswap','snacktok'],
  taggedAccounts: ['cheetos','doritos','officialruffles'],
};

console.log('\n— mentionsAreResolved: the Chester case —');
eq('resolved yields exactly the real handles',
   brands({ ...chester, mentionsAreResolved:true }), ['cheetos','doritos','officialruffles']);
eq('unresolved regenerates the fragments (the bug)',
   brands({ ...chester, mentionsAreResolved:false }),
   ['cheetos','chester','doritos','officialruffles','ruffles']);
eq('flag omitted behaves as unresolved (back-compatible)', brands(chester).length, 5);
eq('still detected as sponsored',
   detectBrandsInPost(post({ ...chester, mentionsAreResolved:true })).isSponsoredContent, true);

console.log('\n— call site: mapInstagramPost (flag never set) —');
eq('caption mentions still contribute', brands({ caption:'#ad love @gymshark', hashtags:['ad'] }), ['gymshark']);
eq('tagged and caption both contribute',
   brands({ caption:'#ad @rhode', hashtags:['ad'], taggedAccounts:['gymshark'] }), ['gymshark','rhode']);

console.log('\n— call site: mapTikTokPost (flag when detailedMentions present) —');
eq('display-name fragment suppressed',
   brands({ caption:'#ad thanks @Huda Beauty', hashtags:['ad'], taggedAccounts:['hudabeauty'], mentionsAreResolved:true }),
   ['hudabeauty']);
eq('resolved with no tags yields nothing',
   brands({ caption:'#ad thanks @Huda Beauty', hashtags:['ad'], taggedAccounts:[], mentionsAreResolved:true }), []);
eq('unresolved fallback still extracts (older actor build)',
   brands({ caption:'#ad thanks @hudabeauty', hashtags:['ad'], mentionsAreResolved:false }), ['hudabeauty']);

console.log('\n— call site: brandAggregation re-detection —');
eq('a repaired tiktok row survives re-detection',
   brands({ caption:'@Chester Cheetah @Doritos', hashtags:['ad'], taggedAccounts:['cheetos','doritos'], mentionsAreResolved:true }),
   ['cheetos','doritos']);
eq('an instagram row re-detects from caption as before',
   brands({ caption:'#ad @gymshark', hashtags:['ad'], taggedAccounts:['gymshark'], mentionsAreResolved:false }), ['gymshark']);

console.log('\n— signals survive; only handles are withheld —');
eq('collab-word signal still fires',
   sig({ caption:'@Stockmann Eesti koostöö', taggedAccounts:['stockmann_eesti'], mentionsAreResolved:true }),
   ['koostöö','mention_collab_pattern','tagged_in_post']);
eq('...but the fragment is not a brand',
   brands({ caption:'@Stockmann Eesti koostöö', taggedAccounts:['stockmann_eesti'], mentionsAreResolved:true }),
   ['stockmann_eesti']);
eq('x-pattern signal still fires',
   sig({ caption:'look x @Rare Beauty', taggedAccounts:['rarebeauty'], mentionsAreResolved:true }).includes('x_brand_pattern'), true);
eq('hashtag signals unaffected',
   sig({ caption:'nothing here', hashtags:['ad','gifted'], taggedAccounts:['brandx'], mentionsAreResolved:true }),
   ['#ad','#gifted','tagged_in_post']);
eq('phrase signals unaffected',
   sig({ caption:'in collaboration with someone', taggedAccounts:['brandx'], mentionsAreResolved:true })
     .includes('in collaboration with'), true);

console.log('\n— caption extraction: no fragments left behind —');
eq('accented brand name yields nothing', brands({ caption:'#ad @loréal', hashtags:['ad'] }), []);
eq('apostrophe name yields nothing', brands({ caption:"#ad @kiehl's", hashtags:['ad'] }), []);
eq('hyphenated name yields nothing', brands({ caption:'#ad @coca-cola', hashtags:['ad'] }), []);
eq('legal handle still extracted', brands({ caption:'#ad @some.brand_01', hashtags:['ad'] }), ['some.brand_01']);

console.log('\n— gates and confidence unchanged —');
eq('tiktok live gate still skips',
   detectBrandsInPost(post({ caption:'@x', hashtags:['tiktoklive'], taggedAccounts:['brandx'], mentionsAreResolved:true })).isSponsoredContent, false);
eq('marketing-industry gate still skips',
   detectBrandsInPost(post({ caption:'@x', hashtags:['adagency','ppc'], taggedAccounts:['brandx'] })).isSponsoredContent, false);
eq('collab pattern still scores high',
   detectBrandsInPost(post({ caption:'@Stockmann Eesti koostöö', taggedAccounts:['stockmann_eesti'], mentionsAreResolved:true })).detectionConfidence, 'high');
eq('unsponsored post yields no brands even when resolved',
   brands({ caption:'just a normal post', taggedAccounts:['brandx'], mentionsAreResolved:true }), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
