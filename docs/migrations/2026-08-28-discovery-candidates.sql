-- ============================================================================
-- Discovery conversion, C5: candidate log + reject cache
--
-- Apply in the Supabase SQL editor in one go. Safe to re-run: every statement
-- is guarded, so a partial application can be repeated without error.
--
-- Touches no existing row. The 62 rows in discovery_runs keep every value they
-- have; the two columns added below are nullable and land as NULL on them.
-- ============================================================================

BEGIN;

-- ── discovery_candidates ────────────────────────────────────────────────────
--
-- Two jobs in one table, deliberately:
--
--   1. Per-run log     — what each hashtag produced, for the funnel query.
--   2. Reject cache    — handles measured below the band, so Discovery never
--                        pays to scrape them twice.
--
-- The cache is the subset where measured_at IS NOT NULL. That gives the table
-- two lifetimes: the log is disposable, the cache is not. Pruning the log
-- would silently disable the cache and Discovery would re-pay for everything
-- it had learned to skip.
--
--   *** SAFE PRUNE RULE: only rows where measured_at IS NULL may be deleted. ***
--
-- See docs/deferred-cleanups.md.

CREATE TABLE IF NOT EXISTS discovery_candidates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES discovery_runs(id),

  -- The search term that surfaced this handle. Kept per row rather than only
  -- on the run, because a run covers many terms and the funnel is per term.
  hashtag        text NOT NULL,
  platform       text NOT NULL,
  handle         text NOT NULL,

  outcome        text NOT NULL,

  -- NULL until the profile scrape returns a reading. Non-NULL rows are the
  -- cache; NULL rows are log only.
  follower_count integer,

  -- When the handle was seen in a post. Always set.
  logged_at      timestamptz NOT NULL DEFAULT now(),

  -- When follower_count was actually MEASURED. NULL when it never was.
  --
  -- Separate from logged_at because the reject-cache TTL compares against it,
  -- and a single timestamp would mean "logged" on an unscraped row and
  -- "measured" on a scraped one — one column carrying two meanings depending
  -- on the nullness of another. A row from a cancelled run would then advertise
  -- a reading that never happened.
  measured_at    timestamptz,

  -- The invariant enforced rather than merely intended: a follower count and
  -- the time it was taken exist together or not at all.
  CONSTRAINT discovery_candidates_measurement_paired
    CHECK ((follower_count IS NULL) = (measured_at IS NULL)),

  -- Closed taxonomy. Constrained because the funnel query groups on it: an
  -- unconstrained typo such as 'already_know' would not error, it would
  -- silently vanish from every count and quietly understate a category.
  --
  -- Adding a value later is DROP CONSTRAINT + ADD CONSTRAINT in one
  -- transaction, exactly as for archive_reason. Existing rows validate against
  -- any superset, so a widening never needs a backfill.
  CONSTRAINT discovery_candidates_outcome_check CHECK (outcome IN (
    -- Filtered before any scrape — these cost nothing
    'entity_excluded',        -- classified as a non-creator
    'already_known',          -- already has a profile in any population
    'cached_reject',          -- previously measured below the band
    -- Reached the scrape phase
    'not_scraped',            -- run cancelled or timed out before this handle
    'scrape_missing',         -- submitted, no profile returned (private/deleted)
    -- Measured
    'imported_active',        -- in band
    'imported_archive_high',  -- above max, archived
    'imported_archive_low',   -- at or above the near-miss floor, archived
    'rejected_below_floor',   -- below the floor: cache only, no creator record
    'unknown_size'            -- 0/null followers, imported non-active
  )),

  -- One row per handle PER RUN. Deliberately not (platform, handle): collapsing
  -- to one row per handle would destroy the per-run history the funnel needs.
  -- A handle seen in three runs keeps three readings.
  CONSTRAINT discovery_candidates_run_handle_unique
    UNIQUE (run_id, platform, handle)
);

-- Cache lookup: given a batch of handles, has this one been measured before?
CREATE INDEX IF NOT EXISTS discovery_candidates_platform_handle_idx
  ON discovery_candidates (platform, handle);

-- Funnel query: everything one run produced.
CREATE INDEX IF NOT EXISTS discovery_candidates_run_idx
  ON discovery_candidates (run_id);

-- ── discovery_runs ──────────────────────────────────────────────────────────

-- Which platform the run targeted. Nullable with no default: the 62 existing
-- rows predate the column and we do not know which platform they used, so they
-- read NULL rather than being backfilled with a guess.
ALTER TABLE discovery_runs ADD COLUMN IF NOT EXISTS platform text;

-- Last sign of life. Written by each per-hashtag call, so a run abandoned by a
-- closed tab is identifiable by how long it has been silent rather than by how
-- long ago it started — a 44-hashtag run is legitimately slow.
ALTER TABLE discovery_runs ADD COLUMN IF NOT EXISTS last_progress_at timestamptz;

-- NOTE: discovery_runs.status is deliberately NOT constrained.
--
-- Existing rows carry two spellings of the same state — 'complete' (53 rows)
-- and 'completed' (9). A CHECK would either reject them or enshrine the typo.
-- Normalising is a data migration with no urgency; it is not bundled here
-- because this migration is meant to touch no existing row.
--
-- Going forward the app writes 'running', 'complete' or 'cancelled'.

COMMIT;
