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

## Reference: finding stranded handles after the near-miss floor moves

Not a cleanup — a query recorded here so it is findable when the floor changes,
rather than living only in a conversation.

`NEAR_MISS_FLOOR` (lib/followerRange.ts, used by lib/discoveryPolicy.ts) splits
Discovery's below-min candidates: at or above it they are archived as
`out_of_range_low`, below it they are cache-only with no creator record.

Changing it is a one-constant change with no migration, but the two directions
are asymmetric:

**Raising it** (15k -> 20k) strands nothing. Handles already archived between
the old and new values stay archived as slightly over-inclusive residue. Leave
them: correcting would mean an archive -> cache move, which is the cross-table
path carrying the promotion hazard.

**Lowering it** (15k -> 10k) strands handles already cached between the new and
old values. They would now qualify for the archive, but the dedupe cache check
compares against `minFollowers`, not against the floor, so they stay rejected
until their TTL expires. Only the follower count was kept, so re-admitting them
needs a re-scrape.

The stranded set, with counts so the cost is visible before deciding:

```sql
SELECT DISTINCT platform, handle, follower_count
FROM discovery_candidates
WHERE outcome = 'rejected_below_floor'
  AND follower_count >= <new floor>
ORDER BY follower_count DESC;
```

Either wait out `REJECT_CACHE_TTL_DAYS`, or re-scrape that list deliberately.

---

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

## Reference: the near-miss archive has no consumer yet

Discovery archives its 15k-30k candidates as `out_of_range_low` rather than
caching them, on the reasoning that a near miss is a creator worth keeping a
full record of. That reasoning depends on machinery that does not exist:

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

**Archiving the 15k-30k band is therefore a deliberate bet on machinery that
has yet to be built**, not a use of something that works today.

It is still the right call. The data is cheap to keep — a few hundred rows per
run — and impossible to recover later: once a handle is cached with only its
follower count, rebuilding the full profile needs a fresh paid scrape. Keeping
the record costs little now and preserves an option; discarding it forecloses
one.

But the bet should be visible rather than inferred. If the promotion path is
still unbuilt when the floor is next reviewed, that is an argument for building
it, not for having archived nothing.
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
