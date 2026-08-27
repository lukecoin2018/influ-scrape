# Making `partnerships` the source of truth (sequenced plan)

**Status:** not started. Blocked on the TikTok truncation repair.

Two problems share one root cause, and they have to be fixed in order.

## The root cause

`brands.total_partnerships_detected` is incremented **in place** by
`app/api/enrich/process/route.ts` (`saveBrandsToTable`), one creator at a time.
Nothing recomputes it from source rows. So the counter and the `partnerships`
table describe the same thing and disagree:

| | |
|---|---|
| brands with `total_partnerships_detected > 0` | 11,462 |
| brands with `avg_partner_follower_count` set | 11,462 |
| `partnerships` rows | 2,194 |
| …written by hashtag discovery | **0** |
| `preferred_creator_tier` set | 0 |
| `active_niches` set | 0 |

The rule this violates: **a derived column has one owner that recomputes it
from the rows it derives from, and is never incremented in place by a writer
that sees only its own slice.** The `casting_*` columns are the pattern to
copy — single owner, recomputed, parameters stored alongside the values.

## Step 0 — done

`recalculate_brand_stats()` is no longer called from
`app/api/database/save-partnerships/route.ts`. It rebuilt all five columns from
a `partnerships` table that cannot reproduce them, so the first hashtag
sponsorship run would have overwritten 11,462 brands' counters with numbers
derived from whatever edges happened to exist — and
`avg/min/max_partner_follower_count` and `preferred_creator_tier` feed
brand-bracket matching in the live platform app.

**Do not restore that call until step 2 is complete.**

## Step 1 — TikTok truncation repair (BLOCKER)

See `docs/tiktok-truncation-repair.md`. Verified, costed at $4.68, not executed.

This blocks everything below. 36% of TikTok mention occurrences are truncated
display names — `@Chester Cheetah` stored as `chester`, `@Huda Beauty` as
`huda`. Backfilling `partnerships` from `creator_posts.detected_brands` before
the repair would write ~1,143 fragment handles as permanent brand edges, in a
table that is about to become the system of record.

## Step 2 — backfill `partnerships` from `creator_posts.detected_brands`

9,209 stored posts carry brand detections. No scraping required; this is
compute plus writes only.

Per detected brand handle on a sponsored post:

- resolve `creator_id` via `social_profiles` → available
- resolve `brand_id` via `brands.instagram_handle` → available; brand stubs
  already exist for detected handles
- `post_url`, `posted_at`, `likes_count`, `comments_count`, `views_count` →
  already on the `creator_posts` row
- `discovery_source` → `'enrich_backfill'`, so backfilled edges stay
  distinguishable from `'hashtag'` and `'brand_feed'`
- `creator_follower_count` → current count, with
  `follower_count_source = 'backfilled'` (same treatment as the existing 2,194)

The unique index on `(creator_id, brand_id, post_url)` makes the backfill
idempotent and safe to re-run.

Note `views_count` will be 0 for anything enriched after the `basicData`
default — see the note in `mapInstagramPost`.

## Step 3 — give the statistics columns a single owner

Once `partnerships` is complete, `recalculate_brand_stats()` becomes not just
safe but *preferable* to in-place increments. Before restoring it:

1. Remove the in-place increment from `saveBrandsToTable`. Two writers for one
   derived column is the bug, and restoring the RPC while the increment
   remains would just alternate between two wrong answers.
2. Confirm what the RPC actually computes. Its body has not been read in this
   work — PostgREST cannot expose `pg_get_functiondef`, so it must be read in
   the Supabase SQL editor. In particular `preferred_creator_tier` and
   `active_niches` have never been populated by anything, so it is unknown
   whether the RPC populates them correctly or at all.
3. Decide where it is called from. Per-edge-write is wrong for the same reason
   the increment is wrong; a recompute keyed by `brand_id` after a batch, or a
   sweep like `scripts/backfill-casting-profiles.mjs`, matches the pattern.

## Step 4 — reconcile

After steps 2 and 3, `total_partnerships_detected` should be reproducible from
`partnerships`. Any brand where it is not is a bug worth finding, and the gap
is the measure of how much the in-place increments had drifted.
