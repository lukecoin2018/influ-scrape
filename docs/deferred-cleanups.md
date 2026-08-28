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
