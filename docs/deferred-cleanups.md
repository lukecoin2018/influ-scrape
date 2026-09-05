# Deferred cleanups

Things consciously left undone, with the reason and the trigger for doing them.

Append to this list rather than fixing in passing — several of these were
deferred specifically so a minimal change could stay diffable, and undoing that
decision later without recording it is how the list gets rediscovered by
accident.

Format: what, where, why deferred, what would trigger doing it.

---

## 1. `chunk()` and `LOOKUP_CHUNK` duplicated

**Where:** `lib/entityFilter.ts` and `app/api/brand-feed/process/route.ts`
(and `lib/profileImport.ts` as of C3b).

**Why deferred:** `loadEntityExcludedHandles` moved to `lib/entityFilter.ts` in
C3a, but `resolveCreators` stayed in the brand-feed route and still needs both.
Sharing them means inventing a `lib/util.ts`, which was scope creep inside a
change whose entire value was being a provably pure move.

**Trigger:** a third genuinely unrelated consumer, or any change to the chunking
behaviour itself. Six lines of a pure generic with no state and no behaviour to
drift — low risk until then.

---

## 2. `PipelineStatus` / `stage` union goes dead for niche mode

**Where:** `lib/types.ts`, `components/ProgressPanel.tsx`

**Why deferred:** C7 converts niche-mode Discovery to the chunked runner, whose
progress is per-item rather than per-stage. Sponsorship mode stays on the old
client pipeline and still uses the four-stage indicator, so the type cannot be
removed while both exist.

**Trigger:** Sponsorship-mode conversion. Until then, deleting it breaks the
unconverted path.

---

## 3. Brand-feed does not pass `signal` to `importScrapedProfiles`

**Where:** `app/api/brand-feed/process/route.ts`

**Why deferred:** C3b added an optional `signal` that guards each batch before
its Apify call. Brand-feed runs a single batch and already checks
`request.signal.aborted` immediately before the call, so passing it would be
redundant. Left alone to keep C3b contained.

**Trigger:** brand-feed ever scraping more than one profile batch — i.e. if
`MAX_NEW_CREATORS_PER_BRAND` rises above whatever batch size it adopts.

---

## 4. `chunk()` duplicated a third time

**Where:** now also `lib/profileImportCore.ts`, whose copy additionally
collapses a non-finite or oversized size to a single batch.

**Why deferred:** same as item 1 — the batch loop needed chunking and inventing
`lib/util.ts` inside C3b would have widened a change scoped to the loop.

**Trigger:** as item 1. The three copies are no longer identical (this one has
the Infinity handling), which is exactly the drift item 1 predicted, so this
raises the priority rather than just adding a copy.

---

## 5. Test resolver hook rather than proper TS test tooling

**Where:** `scripts/ts-resolve.mjs`, wired into `npm test`.

**Why deferred:** the app source uses extensionless relative imports, which
Next and tsc resolve via `"moduleResolution": "bundler"` but Node's ESM
resolver does not. Switching the source to explicit `.ts` specifiers needs
`allowImportingTsExtensions`, which conflicts with the build; installing a
loader (tsx, ts-node) adds a dependency to a project that currently has none
for testing. A 12-line resolve hook was the smallest thing that worked.

**Trigger:** the first test that needs something the hook does not cover —
path aliases (`@/lib/...`), JSON imports, or `.tsx` component tests. At that
point take the dependency rather than growing the hook.

---

## 6. `MODULE_TYPELESS_PACKAGE_JSON` warning on every test file

**Where:** `npm test` output, one warning per `.test.ts` file.

**Why deferred:** Node has to guess the module type for `.ts` files with no
`"type"` in package.json, and reparses them as ESM. The suggested fix —
`"type": "module"` — changes the module system for the whole package, which
reaches the Next build and every config file. Not worth that blast radius to
silence a cosmetic warning.

**Trigger:** taking a real test dependency (see item 5), which would set this
correctly as a side effect. Do not add `"type": "module"` on its own without
verifying the production build.

---

## 7. `profileImportCore` loads `lib/apify.ts` for two pure mappers

**Where:** `lib/profileImportCore.ts` imports `mapProfileToCreator` and
`mapTikTokProfile` from `./apify`.

**Why deferred:** those two are pure data transforms, but they live beside the
Apify HTTP client, which warns at module load when `APIFY_API_TOKEN` is unset.
So the unit tests print "WARNING: APIFY_API_TOKEN is not set" even though they
never call Apify and pass without a token. The core's stated property — that it
reaches neither Apify nor supabase — is true of its behaviour but not of its
imports.

**Fix:** move both mappers to `lib/profileMappers.ts`, leaving `apify.ts` as
client code only. Small and safe, but structural, and C3b was already wider
than its scope.

**Trigger:** do it with C6, which will import the mappers from the new
Discovery route anyway.

---

## Reference: the near-miss floor was removed

`NEAR_MISS_FLOOR` sent Discovery's 15k-30k candidates to the archive and cached
only what fell below it. It no longer exists.

The line it drew ran through a population that is uniformly unqualified. The
archive holds creators who are outside the band but still qualified, and
brand-feed candidates qualify because a brand chose to feature them. A keyword
or hashtag candidate passes through no selection step, so a 20k hit is no more a
creator than a 12k one — the floor was picking a point inside "not qualified"
and treating one side as if it were qualified.

Discovery now caches every out-of-range verdict in both directions and archives
nothing. The constant had one consumer, `discoveryPolicy.ts`, and was deleted
with it. The distribution query that was meant to set its value is still worth
running — it says what Discovery's candidate pool actually looks like — but it
no longer decides anything.

Four rows reached the archive before this change, all from run 328349c2 under
#fashionblogger, between 15,520 and 28,764 followers. Optional cleanup is in
docs/migrations/2026-08-29-remove-discovery-archive-rows.OPTIONAL.sql. Leaving
them costs nothing: nothing reads the archive.

## Reference: the growth premise behind the archive/cache split

The split at the near-miss floor rests on an assumption that is **currently
untested**: that below-min creators grow into range and can be promoted, which
is what makes an archived near-miss worth keeping as a creator record rather
than a cache entry. It is stated as fact in lib/followerRange.ts.

Measured 2026-08-28, all 968 archived `below_min` rows carried a stamped
snapshot and:

- rows whose current count exceeds the stamped count: **0**
- rows now at or above 30k: **0**

That is not evidence against the premise — the archive was two days old
(stamps ran 26-28 Aug), so nothing had had time to grow. It simply has not been
tested yet.

It becomes testable once the archive has some age. The query:

```sql
SELECT
  count(*)                                                        AS archived_below_min,
  count(*) FILTER (WHERE follower_count > import_status_follower_count) AS grew_at_all,
  count(*) FILTER (WHERE follower_count >= 30000)                 AS crossed_into_band,
  min(import_status_at)                                           AS oldest_stamp,
  max(import_status_at)                                           AS newest_stamp
FROM social_profiles_archive
WHERE archive_reason = 'below_min'
  AND import_status_follower_count IS NOT NULL;
```

Worth running once the oldest stamp is a few months old.

### Read the result carefully — zero is ambiguous

`follower_count` on an archived row only refreshes when something re-imports
that row. Nothing currently reads the archive tables and no pipeline refreshes
them, so this query measures **re-observation as much as growth**.

A `crossed_into_band` of zero is therefore ambiguous between two very different
findings:

1. below-min creators do not grow into range, or
2. nothing has re-observed these rows, so no growth could have been recorded.

**A zero result is not on its own evidence for raising the floor.** Before
acting on it, establish which case you are in — compare `grew_at_all` against
zero, and check whether anything has re-imported archived rows since the stamps
were written. If `grew_at_all` is also zero, case 2 is the more likely reading
and the query has told you nothing about growth.

The premise only becomes testable once something re-observes archived rows. If
that never gets built, the honest conclusion is that the premise is untestable
as designed, not that it is false.

---

## Reference: the archive has no consumer yet

Brand-feed archives its out-of-range candidates on the reasoning that a
qualified creator outside the band is worth keeping a full record of. Discovery
no longer archives anything, so this now concerns brand-feed alone. The
reasoning still depends on machinery that does not exist:

- **Nothing reads the archive tables.** An unbounded search for
  `social_profiles_archive` / `creators_archive` / `v_social_profiles_all`
  finds only `lib/creatorImport.ts` (which writes them and rolls status up),
  `app/api/brand-feed/process/route.ts` (which reads the union view to resolve
  edges), and `update-creator` / `save-partnerships` resolving against
  `creators_archive`. No enrichment, embedding, intelligence or location
  pipeline reads either table.
- **Nothing refreshes `follower_count` on an archived row.** Every queue builder
  filters `import_status = 'active'`, which archived rows are not, so they are
  never re-scraped.
- **The promotion path that would use them is blocked.** Moving a row from the
  archive back to `social_profiles` is the cross-table move that produces
  duplicates: `lib/creatorImport.ts` picks its destination table from the
  incoming status alone, never consults the `population` it reads at line 125,
  and there is no delete anywhere in the codebase. So a promotion leaves the row
  in both tables, after which `.maybeSingle()` on the union view errors, that
  error is discarded, and the next import splits the creator into two rows.
  Currently latent: brand-feed only imports handles with no existing profile,
  so the path has never run.

**Brand-feed's archiving is therefore a deliberate bet on machinery that has yet
to be built**, not a use of something that works today.

It is still the right call there. A brand-feed candidate is qualified by the
brand's own selection, the data is cheap to keep, and it is impossible to
recover later: once a handle is cached with only its follower count, rebuilding
the full profile needs a fresh paid scrape.

It was NOT the right call for Discovery, which is why Discovery stopped. The
difference is entirely in whether the candidate passed a selection step, not in
how far outside the band it landed.

If the promotion path is still unbuilt when this is next reviewed, that is an
argument for building it, not for brand-feed having archived nothing.
---

## 8. Two `discovery_runs.status` spellings

**Where:** `discovery_runs.status` holds both `'complete'` (53 rows) and
`'completed'` (9 rows) for the same state.

**Why deferred:** C5 adds a CHECK constraint to `discovery_candidates.outcome`
but deliberately does NOT constrain `discovery_runs.status`, because a CHECK
would either reject the 9 legacy rows or have to enshrine the typo. The C5
migration is meant to touch no existing row.

**Trigger:** normalising is a one-line UPDATE plus a CHECK, but it is a write to
historical rows and belongs in its own change with its own verification. Do it
when something actually reads `status` and has to handle both spellings —
nothing does today.

---

## 9. Modules that unit tests need must not import `./supabase`

**Where:** the pattern, not a single file. Bit twice: `lib/profileImport.ts`
(fixed by splitting `profileImportCore.ts` in C3b) and `lib/discoveryRun.ts`
(fixed by splitting `discoveryCache.ts` in C5).

**Why it happens:** `lib/supabase.ts` calls `createClient` at module scope with
non-null assertions, so importing anything that transitively reaches it throws
`supabaseUrl is required` without credentials. A unit test then cannot load the
module at all, whatever it was trying to test.

**The rule:** pure logic worth testing goes in a module that imports no client.
The database access goes in a thin sibling that re-exports it.

**Trigger:** if this bites a third time, make `lib/supabase.ts` lazy — export a
getter that constructs on first use rather than at import — which would remove
the constraint entirely instead of routing around it each time.

---

## 10. RESOLVED — `scrape_missing` attribution is now exact

**Was:** the Discovery route inferred the missing set by difference (handles
sent minus handles returned) and capped it at `imported.attempted`, so an
interrupted run could label unreached handles as `scrape_missing`.

**Resolved in C6** by having `runProfileImport` report `scrapedHandles` — the
handles whose batch was submitted AND returned successfully. Missing is now
computed against that rather than against the whole input, so:

- never reached (cancelled, timed out) -> keeps its `not_scraped` row
- batch threw -> keeps `not_scraped`; billed, but produced no data
- batch returned, no profile for this handle -> `scrape_missing`

The information was available at the point of attribution; the batch loop knew
which handles it had covered and simply was not saying so.

---

## 11. `cacheOnly` overlaps `measured`

**Where:** `lib/profileImportCore.ts` — `cacheOnly` is exactly the subset of
`measured` where `decision === 'cache_only'`.

**Why deferred:** `cacheOnly` predates `measured` and has a tested contract
(its key set is asserted to be exactly handle/platform/followerCount, so the
cache write cannot silently start depending on more). `measured` was added for
the per-handle outcome write-back, which needs the status too. Removing
`cacheOnly` now would drop that assertion.

**Trigger:** if a third consumer of either appears. Until then the docstring on
`MeasuredHandle` states the relationship, so it is explicit rather than
accidental.

---

## 12. RESOLVED — `mapTikTokProfile` field names, except the avatars

**Was:** `abe/tiktok-profile-scraper` emits `image` and `tagline`; the mapper
read `profileImage` and `displayName`. Neither exists, so both silently
resolved to empty since the initial commit.

**Resolved** by adding fallbacks (`displayName || tagline`,
`profileImage || image`, `profileUrl || url`). Additive and safe: the original
fields are always undefined, so nothing that worked before changes.

`full_name` is backfillable without re-scraping — the value is already in
`social_profiles.platform_data->>'tagline'`. See
docs/migrations/2026-08-29-backfill-tiktok-full-name.sql.

### Deliberate data loss: TikTok avatars before 2026-08-29

**`profile_pic_url` is NOT backfillable and will not be recovered.** The actor
returned the image URL on every one of those runs and the mapper discarded it
without storing it anywhere — unlike the display name, which survived by
accident in `platform_data.tagline`. There is nothing on disk to recover from.

Restoring them would mean re-scraping 3,347 TikTok profiles at $0.005 each,
roughly $17, to recover a cosmetic field for creators who may never be used.
**That is a deliberate decision not to spend it.** Profiles scraped from
2026-08-29 onward carry avatars; older ones will fill in only if something
re-enriches them for an unrelated reason.

If a future change makes avatars matter — a public-facing view, a client-facing
export — this is the reason they are missing and the price of fixing it.


## 13. Sponsorship mode still runs the old client pipeline

**Where:** `app/page.tsx` — `startLegacyDiscovery`, reached only when
`mode === 'sponsorship'`.

**What it misses:** everything the conversion added. No entity filter, no reject
cache, no follower-range stamping (it still discards out-of-range creators after
paying to scrape them), no Stop, no run record until completion, and no
candidate log — so R3's funnel is blank for sponsorship runs.

**Why deferred:** converting it needs the brand-extraction work that was
explicitly out of scope — `detectBrandsInPost` and its normalizer problem, and
the brand profile scrape at the end of the legacy path. Half-migrating it would
have been worse than leaving it whole.

**Trigger:** the brand-extraction work. Until then the two paths coexist, which
is why `PipelineStatus` and the four-stage `ProgressPanel` are still alive
(item 2) — sponsorship is their only remaining consumer.

---

## 14. Results band filter uses `total_followers`, not the platform's count

**Where:** `app/api/database/get-creators/route.ts` filters `total_followers`,
the creator-level aggregate across platforms.

**What breaks:** a creator at 20k on Instagram and 20k on TikTok has a
`total_followers` inside a 30k-500k band while being out of band on either
platform individually. A band query returns them; a platform query should not.

**Currently zero impact, and checked rather than assumed:** creators 7,247
against social_profiles 7,131, and a query for rows carrying both an
`instagram_followers` and a `tiktok_followers` returns none. No creator has two
profiles yet.

**Trigger: the first creator discovered on both platforms.** TikTok Discovery
makes that possible for the first time, so this stops being latent as soon as
the same person is found on both. The Discovery Results tab no longer uses this
route (it reads discovery_candidates instead), but the Creators page still does.

---

## 15. Every fetch boundary casts without validating

**Where:** all four client fetches in `app/page.tsx` —
`/api/discover/start`, `/process`, `/finish`, `/api/discover/run-results` —
plus `DiscoveryFunnel`'s `HashtagResult`. Each does `data as T` with no runtime
check.

**Framing, because this is not a style note:** it is the mechanism behind both
bugs in this conversion that unit tests could not reach and only inspection
found. The `v_creator_summary` mismatch (per-creator columns assigned to a
per-profile shape) would have rendered blank rows and then thrown on
`undefined.toLocaleString()`. The unscoped Results query returned the wrong
rows with entirely valid types. In both cases the compiler was satisfied and the
tests passed.

**How it fails now:** a renamed or missing numeric field becomes `undefined`,
`DiscoveryFunnel`'s `sum()` yields `NaN`, and the totals row renders "NaN". No
crash, silently wrong numbers — on the screen you are using to judge whether a
paid run worked.

**Consequence for now:** read the first run's funnel against the SQL rather than
trusting the screen. That is why the C8 procedure pairs every displayed number
with a query.

**Fix:** a narrow parse at each boundary — not necessarily a validation library,
a hand-written `parseHashtagResult` that returns null on shape mismatch would
catch the whole class.

**Trigger:** a third bug of this kind, or the next route added to the page.

---

## 16. Stop's server-side half is unverified in production

**Where:** `app/api/discover/process/route.ts` reads `request.signal.aborted` at
two points, and passes the signal into the profile batch loop.

**What is unverified:** whether Vercel surfaces a client disconnect as an
aborted `request.signal` at all. A platform that buffers the request may never
fire it. Locally `next dev` does not exercise this, and no unit test can — the
tests inject their own AbortSignal, which proves the loop responds to a signal,
not that the platform sends one.

**If it does not fire:** the client-side half still works — the fetch is aborted
and the runner stops issuing new hashtags — but the route already in flight runs
to completion, including every remaining profile batch. At 900 handles that is
up to eighteen billable Apify runs after Stop was pressed. Silent, and visible
only on the bill.

**Named deploy-time check.** After the first deployed run:

1. Start a run with one hashtag at 500 results, so the profile phase has many
   batches.
2. Press Stop during the profile phase.
3. Read the run's row: `SELECT status, last_progress_at FROM discovery_runs
   WHERE id = '<run id>';` and count candidates that reached a measurement:
   `SELECT count(*) FROM discovery_candidates WHERE run_id = '<run id>'
   AND measured_at IS NOT NULL;`
4. Wait two minutes and re-run the count. **If it keeps rising after Stop, the
   signal did not fire** and batches are still running.

**If it does not fire,** the fallback is a server-side deadline short enough to
bound the damage, or a cancellation flag on discovery_runs that the batch loop
polls between batches — neither of which depends on the platform propagating a
disconnect.

---

## 17. ResultsTable cannot render a missing count

**Where:** `components/ResultsTable.tsx` formats `followingCount` and
`postsCount` with `.toLocaleString()` unconditionally.

**What it means:** `v_creator_summary` carries neither, so
`summaryRowToCreator` forces `0`. Every creator in the Discovery Results tab
shows 0 following and 0 posts, which reads as a measurement rather than as an
absence — and 0 is a legitimate value, so the display cannot be told apart from
a real zero.

**Why not fixed with F1/F3:** rendering "—" needs
`DiscoveredCreator.followingCount` and `.postsCount` widened to `number | null`,
which reaches roughly fifteen construction sites across `app/add`,
`app/import`, `lib/apify`, `lib/profileImportCore` and `ExportButton`, and
requires null handling in ResultsTable's sort comparators, which sort on both
fields. That is a wider refactor than a two-fix commit should carry.

**Trigger:** any other reason to touch DiscoveredCreator's shape, or the first
time someone reads a Discovery result as "this creator has posted nothing".

---

## 18. Turbopack infers the workspace root from a stray home-directory lockfile

**Symptom:** `next build` prints

    Warning: Next.js inferred your workspace root, but it may not be correct.
    We detected multiple lockfiles and selected the directory of
    /Users/lukaslanger/package-lock.json as the root directory.

Next walks up looking for lockfiles, and a `package.json` +
`package-lock.json` sitting in the developer's home directory (dated 30 March,
containing only a `@supabase/supabase-js` dependency) outranks this project's
own. Root affects module resolution and output file tracing.

**Attempted and reverted.** Setting `turbopack.root` to
`path.resolve(import.meta.dirname)` silenced the warning and the production
build passed — but `next dev` then failed to resolve `tailwindcss`, reporting it
was looking in `/Users/lukaslanger` using that stray `package.json` as the
description file.

The config itself was NOT at fault: logging showed `import.meta.dirname`
evaluating to `/Users/lukaslanger/inf-scraper` under the config loader, exactly
as intended. The most likely cause was a `.next` directory holding both
production and dev artifacts (see item 19), and the interaction could not be
cleanly reproduced afterwards. Reverted rather than kept on suspicion: the
benefit is a cosmetic warning, and the cost was a dev server that would not
serve a page.

**Do not simply re-apply it.** If the warning becomes worth fixing:

1. Delete the stray `/Users/lukaslanger/package.json` and `package-lock.json` if
   nothing uses them — that removes the cause rather than overriding it, and is
   the cleanest fix. It is outside the repo, so it is the developer's call.
2. Or re-apply `turbopack.root` and verify with `next dev` serving an actual
   page, on a freshly cleared `.next` — not with `next build` alone.

**The verification gap is the real lesson.** G1 was verified with
`npx next build` only. A passing production build is not evidence that the dev
server works; the two use different resolution paths and, worse, share `.next`.

---

## 19. `next build` and `next dev` share `.next` and interfere

**What happened:** the commit sequence was verified by running `npx next build`
after each change. That writes production artifacts into `.next`. Starting
`next dev` afterwards leaves the directory holding both — production
`server/`, `static/` and `required-server-files.json` beside a dev `dev/` and
`turbopack/` cache — which produced module-resolution failures that looked like
a config bug (item 18).

**Rule going forward:**

- Run `npx next build` for verification in a **separate git worktree** with
  `node_modules` symlinked, so the working project's `.next` is never touched.
- Or, if building in place, `rm -rf .next` before starting `next dev`.
- Never run `next build` while a `next dev` server is running against the same
  directory.

**Trigger:** none — this is a process rule, not a code change. It is recorded
because the failure it causes is misattributed to whatever config changed most
recently, which is exactly what happened here.

---

## 20. 121 orphaned creator rows accumulated over six months

**What:** `creators` rows with no `social_profiles` and no
`social_profiles_archive` row beneath them. Roughly 121 existed before
2026-08-29, when an unscoped DELETE removed them (see
docs/incident-2026-08-29-unscoped-delete.md). Something creates them and nothing
cleans them up.

**Shape, from `creator_registry` first_seen_at dates:** they arrive in batches —
18 on 25 Feb, 19 on 14 Mar, 11 on 24 Mar, 16 on 15 Jun, 14 on 3 Jul, 14 on
14 Jul, 12 on 20 Jul. Batch arrival points at a bulk path failing partway rather
than a steady trickle.

**Hypothesis, from reading the code and NOT verified:**
`lib/creatorImport.ts` inserts the `creators` row first, then writes the profile,
and `continue`s if the profile write fails — leaving the creator behind with
nothing beneath it. If that is the cause, the same path is still live.

**Why it matters beyond tidiness:** `new_creators_added` counts creator rows, so
it has been over-counting for however long this has been happening. Any yield
figure derived from it is inflated.

**Trigger:** after the TikTok keyword runs. Read-only investigation first —
find the path, confirm the mechanism, and only then decide whether anything
needs cleaning up. Given the incident, no deletion is proposed as part of it.

---

## 21. The C8/TikTok comparison confounds three variables

C8 (Instagram, #fashionblogger + #streetstyle) yielded 11 in-band imports and
zero usable creators: shops in Riyadh, Bishkek and Tashkent, five labelled
Clothing (Brand) by Instagram itself.

The first TikTok probe (#tryonhaul, as it turned out — see the silent-rewrite
fix) yielded 20 that look like real creators: personal handles, personal names,
English-language, in band.

**Three things differ at once** and the runs cannot separate them:

1. **Platform** — Instagram vs TikTok.
2. **Term intent** — topic label (#fashionblogger) vs commercial intent
   (#tryonhaul). The second describes what someone is DOING with a product.
3. **Search mechanism** — both runs were in fact hashtag searches, so this one
   did NOT vary, though it appeared to at the time.

The commercial-intent hypothesis is the interesting one and is untested: a
TikTok run on a topic label, or an Instagram run on a commercial-intent term,
would isolate it. Worth knowing before concluding that the platform is what
matters, because term choice is far cheaper to change than platform.

**Trigger:** after the keyword-vs-hashtag comparison, which isolates variable 3.

---

## 22. `fetchAllRows` documents its ordering contract but does not enforce it

**Where:** `lib/supabasePaging.ts`.

**The contract:** the docstring says `makeQuery` "must apply a deterministic
`.order()`", because without a stable sort Postgres may return rows in a
different order per page, duplicating some and dropping others.

**Audited 2026-09-02, and every caller complies.** Fifteen real call sites
across nine files; fourteen order by `id` and one by `alias`, and in every case
that column is the table's primary key. **No past measurement taken through `fetchAllRows` is wrong.**

The bug that prompted the audit was in an ad-hoc measurement script written for
the location investigation, which paged `v_creator_summary` with a `Range`
header and no `order` at all. Per-value tallies came back different on repeat
runs (`Nyc` at 114 and then 116) while the total still summed correctly to
6,026 — so the error was invisible in the one number being used to check it.

**Two things are still worth fixing:**

1. **The contract is prose.** `fetchAllRows` cannot see whether `.order()` was
   applied — the builder is opaque to it — so this is enforced by every author
   reading the docstring. That worked fifteen times out of fifteen, which is
   evidence it is a good docstring, not evidence the class of error is closed.
   The failure it prevents is silent and the check that would catch it (a total
   that matches) does not catch it.

2. ~~**One call site orders by a non-unique column.**~~ **WITHDRAWN — this was
   wrong.** `loadAliases` in `lib/brandFeedQueue.ts` orders `brand_aliases` by
   `alias`, which was flagged here as a non-key column crossing a page boundary
   by twenty rows. **`alias` IS the primary key of `brand_aliases`** — confirmed
   from PostgREST's OpenAPI description, which names it as such. It is unique by
   constraint, the paging is deterministic, and there is nothing to fix.

   Recorded rather than deleted because the reasoning error is the reusable
   part: "not named `id`" was treated as "not a key". Uniqueness was then
   measured empirically (5,020 of 5,020 distinct) and that result was read as
   luck rather than as the constraint it actually was — the measurement agreed
   with the truth and was still interpreted backwards. The table is not defined
   in any tracked migration, which is what made the key invisible from the repo;
   the fix was to ask the database, not to infer from the column name.

**Trigger:** (2) is closed — no change needed. For (1), the honest options are a
runtime assertion (hard: the builder is opaque) or a lint rule. Neither is worth
building today given fifteen out of fifteen compliance, but if a paging bug ever
appears in a real call site, stop relying on the docstring.

**Note on the audit itself:** the first pass at it used the regex
`fetchAllRows\s*(?:<[^>]*>)?\s*\(`, which cannot match the nested generic in
`fetchAllRows<Record<string, unknown>>` and silently skipped a call site. Redone
with a bracket-depth walk. Counting call sites with a regex over TypeScript
generics is the same class of error as grepping build output.

**Rule for ad-hoc measurement, which is where this actually bit:** any bulk read
of this database for measurement needs a stable sort, and **a total that matches
is not evidence the breakdown does.** Cross-check per-value figures with
`Prefer: count=exact`, which does not depend on pagination at all.

---

## 23. RESOLVED — the `.next`-with-a-running-server failure is now guarded

**Was:** `rm -rf .next` while `next dev` runs against the same directory
corrupts the Turbopack cache (item 19), producing module-resolution failures
that get misattributed to whatever config changed most recently. It is written
up in item 19 AND in docs/verification-rules.md, and it happened **three times
across two sessions anyway** — twice in the session that added this entry.

**Why the doc was the wrong instrument.** The rule is only consulted when
someone is already thinking about `.next`. The failure happens when they are
thinking about something else and reach for `rm -rf .next` as a reflex. A rule
that has to be recalled at exactly the moment attention is elsewhere is not
doing the job, however clearly it is written.

**Resolved by `scripts/verify.sh`**, which makes both recurring failures
structurally impossible rather than documented:

- It **refuses to run** if a Next dev server is up — exits 2, deletes nothing,
  prints the offending PIDs and how to stop it. Verified by running it with a
  server up and confirming `.next` survived.
- It clears `.next` before **each** step rather than once at the start.
- Every step is judged by `$?`. Nothing greps output. It exits non-zero if any
  step did, so it cannot report a failing build as green.

Usage: `scripts/verify.sh` (test + tsc + build) or `--quick` (skips the build).

**Deliberately NOT automated: the dev-server check.** It needs a person to load
a page and look at it, and a script that pretended to cover it would recreate
the exact "a passing build means it works" error that item 18 records. The
script prints the reminder and stops.

**Trigger:** if the failure recurs despite this, the next step is a git
pre-commit hook or an alias, because it would mean the sweep is being run by
hand rather than through the script.


---

## 24. `locationMeta.cityCode` is not always a city

**Where:** `lib/postLocation.ts`, `creator_posts.place_city_code`,
`social_profiles.place_city_code`.

The field looks like a city identifier and is not. Measured against the
GeoNames dumps across every value seen in real datasets, it takes **four**
different kinds of value:

1. **A city.** New York City 5128581, Toronto 6167865, Miami 4164138,
   Brooklyn 5110302, Las Vegas 5506956, Medellín 3674962, Orlando 4167147,
   Los Angeles 5368361, Providence 5224151 — and also Halton, population
   2,218, and Frostproof FL, which TikTok itself labelled "Florida".
2. **An admin1 region.** 1609348 is Bangkok the *province*; 6697808 is the
   South Aegean *region*, on a post TikTok named "Naxos".
3. **The literal string `"0"`**, meaning "country-level tag, no city". Found on
   @donnacayman, whose three geotagged posts are all British Virgin Islands
   with no city. GeoNames ids start at 1, so this is a sentinel, not a place.
   Fixed on extraction; the rows written before that are repaired by
   docs/migrations/2026-09-03-null-zero-city-code.sql.
4. **An id GeoNames does not have.** 52200211 (Sharm el-Sheikh) and 77400241
   (Muskoka Lakes) are far outside GeoNames' range — TikTok's own place ids for
   locations GeoNames lacks.

**`countryCode` has none of these problems.** Every value seen has resolved
exactly, now 8 for 8: United States, Canada, Thailand, British Virgin Islands,
United Kingdom, Colombia, Greece, Egypt.

**The rule:** group on `cityCode` for identity, because that is all the
dominance calculation needs. Filter and report on `countryCode`. **Do not
resolve `cityCode` to a name and present it as a city** — for cases 2 and 4
that is wrong, and for case 3 it was actively harmful before the fix.

**A city-level market filter built on these codes would have failed silently**,
which is why the market-facing column is the country one.

**Trigger:** if city-level filtering ever becomes necessary, resolve codes
against the GeoNames dumps at ingest and store the feature class alongside, so
a region can be told from a city. Until then the ambiguity costs nothing
because nothing reads the code as a name.

---

## 25. QUEUED, NOT DEFERRED — import seed candidates off the free item

**Status: next piece of work after the first seed run, decided 2026-09-05.**
Listed here because this is where its history is, not because it is waiting for
a trigger that may never come. The trigger is one run away and the decision
rule is written below.

**Where:** `lib/discoveryCost.ts` (`estimateSeedExpansionCost`),
`app/api/discover/process/route.ts` step 4, `lib/apify.ts` (`mapTikTokProfile`).

Seed expansion reuses `importScrapedProfiles` exactly as the hashtag and
keyword sources do, so every in-band candidate costs $0.005 for a TikTok
profile scrape. The following-list item it came from already carries most of
what that scrape ends up writing, for free.

    200-entry seed, as built                     ~$0.57
    200-entry seed, importing off the free item  ~$0.20

**A two-thirds cut — and the change that would actually make seed expansion
the cheapest source.** At present it is not: with the profile scrape it costs
$0.00775 per in-band head against keyword search's $0.00591 (see
`docs/seed-expansion-investigation.md`, corrected after ledger item 27 was
fixed). Dropping the scrape takes it to **$0.00275**, less than half keyword's.

### Field by field, against what `mapTikTokProfile` actually writes

Coverage measured over the **516 items already paid for** across the four seed
runs of 2026-09-04 — not a sample of one, and not an assumption.

| Written to `social_profiles` | From the profile scrape | On the free following item | Coverage |
|---|---|---|---|
| `handle` | `profile.username` | `authorMeta.name` | **100%** |
| `full_name` | `tagline` | `authorMeta.nickName` | **100%** |
| `bio` | `profile.bio` | `authorMeta.signature` | **90.7%** |
| `follower_count` | `followers.raw` | `authorMeta.fans` | **100%** |
| `following_count` | `following.raw` | `authorMeta.following` | **100%** |
| `posts_count` | `videos.raw` | `authorMeta.video` | **100%** |
| `is_verified` | hardcoded `false` | `authorMeta.verified` | **100%** |
| `profile_pic_url` | `profileImage \|\| image` | `authorMeta.avatar` | **100%** |
| `profile_url` | `profileUrl \|\| url` | `authorMeta.profileUrl` | **100%** |
| `platform_data.likes_count` | `likes.raw` | `authorMeta.heart` | **100%** |
| `platform_data.video_count` | `videos.raw` | `authorMeta.video` | **100%** |
| `engagement_rate` | always `null` | absent | — both null |
| `is_business_account` | absent on TikTok | absent | — both absent |
| `category_name` | absent on TikTok | absent | — both absent |
| `website` | always `''` | `authorMeta.bioLink` | **0% on candidates** |

**Two of these rows favour the free item outright.** `is_verified` is
*hardcoded to false* by `mapTikTokProfile`, so the scrape has never written a
real verification flag; the free item carries the actual boolean on 100% of
items. `full_name` currently comes from `tagline`, and of 3,458 TikTok-primary
creators exactly **one** ever got a `full_name` from it — `nickName` is present
on 100%.

**One correction to an earlier claim.** `bioLink` is on the item's
`connectedTo` (the seed) but is **0% on candidates** — as are `createTime` and
`commerceUserInfo`. An earlier note listed `bioLink` among the free fields; it
is not. It costs nothing today either way, because `website` is written as the
empty string regardless.

**So the free item is not a subset of the scrape — on TikTok it is a superset
of everything the mapper writes**, plus `ttSeller`, `privateAccount`, `digg`
and `friends` that nothing reads yet.

### What still needs the first real run

The table above is the *item* side, measured. What it cannot settle is what the
profile scrape returns for the **same handles** — whether `abe/tiktok-profile-scraper`
carries something on a live lookup that the following list does not, and
whether the two disagree on a count. So after the first seed run:

    for the handles that run imported, compare the stored row against the
    following item it came from, field by field, and list every disagreement

If nothing the funnel reads is lost, take the free path.

### Why this got promoted

It was scoped as a saving. Fixing ledger item 27 showed it is more than that.

With the profile scrape, seed expansion costs **$0.00775 per in-band head
against keyword search's $0.00591** — it is the DEARER source, not the cheaper
one, which is the opposite of what an earlier draft of
`docs/seed-expansion-investigation.md` claimed. Without the scrape it is
**$0.00275**, less than half keyword's.

So this is not a two-thirds discount on an already-good source. **It is the
difference between seed expansion being worth using on cost and not.** What it
otherwise offers — a free bio on 90.7% of candidates where xmolodtsov's
`channel` object carries nothing bio-shaped at all, plus `ttSeller` and a 36.5%
in-band rate against ~28% — is real and is the reason to run it either way. But
the cost argument only exists on the far side of this change.

### The decision rule, written before the evidence

Stated in advance so the result is not read to taste, per
`docs/verification-rules.md`:

**If the profile scrape returns nothing the funnel reads that the following
item did not already carry, build it immediately.** Not "consider it", not
"ledger it again".

"Nothing the funnel reads" means every field in the item-side table above, plus
any count disagreement large enough to change an `import_status` band decision.
A field the scrape returns that nothing reads is not a reason to keep paying
for it.

**If the scrape does return something load-bearing**, name the field, say what
reads it, and price keeping the scrape only for the candidates that need it.

### Why it was not done up front

It makes seed imports structurally different from every other source's — a
second import path with its own field mapping and its own failure modes, on a
source whose first real run had not happened. The estimate charges for the
scrape and therefore reads high, which is the right direction to be wrong in.
Measure first: the same rule that killed the compounding loop.

---

## 26. `post_language` coverage bounds the seed queue

**Where:** `app/api/discover/seed-candidates/route.ts`.

The seed queue selects on `post_language`, which is written by enrichment.
Measured 2026-09-05:

    tiktok, import_status = 'active'      3,712
    + following_count >= 150              2,362
    + post_language present                 334   <- the ceiling
      es 76 · en 235 · pt 2

The queue is bounded by **enrichment coverage**, not by the follower threshold.

**This shrinks on its own.** `post_language` only came into existence on
2026-09-03, so it is present only on creators enriched since. Every active
TikTok creator following 150+ picks one up the first time it re-enriches, and
the queue grows toward the 2,362 — roughly seven times today's pool, with no
code change. The small number is a statement about how far re-enrichment has
got, not about the mechanism.

**The lever, if the queue ever feels short**, is falling back to
`detected_language`. It was deliberately not used: the actor's language call
beat the heuristic in all four measured disagreements
(`docs/migrations/2026-09-03-post-place-language-biolink.sql`), and a seed
chosen on a worse signal spends real money. Widening this is a decision to take
knowingly, with the accuracy difference in view — not a fallback to add quietly
because a list looked empty.

**Trigger:** the queue runs dry for a market, or enrichment coverage on active
TikTok profiles passes ~50% and the constraint stops binding.

---

## 27. `searchResultPrice` exists, is tested, and nothing calls it

**Where:** `lib/discoveryCost.ts` — `searchResultPrice` at the top,
`estimateDiscoveryCost` further down.

The keyword-search actor swap added `searchResultPrice(platform, source)`,
which returns `TIKTOK_KEYWORD_RESULT_USD` ($0.00025) for a TikTok keyword run
and the table price otherwise. `lib/discoverySources.test.ts` covers it in four
assertions.

**`estimateDiscoveryCost` does not call it.** It still reads
`price.hashtagResult` unconditionally, so the SetupPanel quotes a TikTok
**keyword** run at the clockworks rate of $0.0037 per result instead of
xmolodtsov's $0.00025 — roughly **15x too high**. On a six-term, 200-result
keyword run that is $4.44 quoted against $0.30 actual for the search phase.

Found while rebasing seed expansion onto this work, not by a test: the tests
prove the helper is right, and nothing proves it is *used*. A function with
passing tests and no caller is the shape of exactly this bug.

**The fix is one line** — `searchResultPrice(platform, searchSource)` in place
of `price.hashtagResult` — and `searchSource` is now already a parameter of
that function, so nothing else has to change. It was deliberately NOT done
inside the seed-expansion commit: it changes a number the operator reads before
spending, on a source seed expansion does not touch, and that deserves its own
change and its own before/after.

**RESOLVED** in the commit that follows seed expansion. `hashtagUsd` now reads
`searchResultPrice(platform, searchSource)`; `searchSource` was already a
parameter after the seed work, so the change is one line. Three assertions were
added to `lib/discoveryCost.test.ts` — on the ESTIMATE, not on the helper,
which is the distinction that mattered: every existing test proved the helper
was right and none proved it was used.

**What the fix cost to find, recorded because it is the interesting part.**
Wiring it broke a passing test in `lib/seedExpansion.test.ts` that asserted
`seed.hashtagUsd < keyword.hashtagUsd` — "the following list is the cheaper
fetch". It is not; it is four times dearer per result. That assertion had been
green only because the estimate was quoting keyword at the clockworks rate, so
the bug had propagated into a test AND into a claim in
`docs/seed-expansion-investigation.md` that seed expansion was the cheapest
source in the pipeline. Both are corrected. A mispriced constant does not stay
in the pricing module; it ends up in the documents people make decisions from.
