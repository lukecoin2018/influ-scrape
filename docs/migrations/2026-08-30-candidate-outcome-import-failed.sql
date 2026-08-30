-- ============================================================================
-- discovery_candidates.outcome gains 'import_failed'
--
-- No placeholders. Safe to paste whole. Touches no existing row — this widens
-- the CHECK only. There is no DELETE and no UPDATE in this file.
--
-- The outcome used to be recorded on INTENT: a handle was marked imported
-- before saveDiscoveredCreators ran, and that function catches per creator and
-- counts failures. So a save that failed for one handle still reported it as
-- imported_active, and the funnel could describe an import that never happened.
--
-- It did not fire on run 328349c2 — every save there succeeded — but a run
-- whose entire purpose is reading the funnel is the worst place for a silent
-- discrepancy.
--
-- Outcomes are now reconciled against saveDiscoveredCreators' savedHandles.
-- A handle that was scraped, measured and attempted but NOT confirmed gets
-- 'import_failed': it was billed, it has a follower reading, and no creator
-- record exists for it. That is a different thing from every other outcome and
-- needs its own value rather than being folded into one that misdescribes it.
-- ============================================================================

BEGIN;

ALTER TABLE discovery_candidates
  DROP CONSTRAINT IF EXISTS discovery_candidates_outcome_check;

ALTER TABLE discovery_candidates
  ADD CONSTRAINT discovery_candidates_outcome_check CHECK (outcome IN (
    -- Filtered before any scrape — these cost nothing
    'entity_excluded',
    'already_known',
    'cached_reject',
    -- Reached the scrape phase
    'not_scraped',
    'scrape_missing',
    -- Measured, and imported
    'imported_active',
    'unknown_size',
    -- Measured, attempted, and the write did not land
    'import_failed',
    -- Measured, and cached instead of imported
    'rejected_below_floor',
    'rejected_above_max',
    -- Legacy: written before Discovery stopped archiving. Not produced now.
    'imported_archive_high',
    'imported_archive_low'
  ));

COMMIT;
