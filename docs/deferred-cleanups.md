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
