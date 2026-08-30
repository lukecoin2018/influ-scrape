-- ============================================================================
-- discovery_candidates.outcome gains 'rejected_above_max'
--
-- No placeholders. Safe to paste whole.
--
-- Discovery no longer archives out-of-range candidates in either direction;
-- both go to the reject cache. The cache preserves direction because it decides
-- re-admission: a below-min handle can grow into the band, whereas an above-max
-- one only re-enters if the band's ceiling is raised.
--
-- 'rejected_below_floor' is KEPT rather than renamed. It already describes the
-- below-min case, 131 rows carry it, and with the near-miss floor removed
-- "floor" now unambiguously means the band's minimum. Renaming would rewrite
-- history for no gain.
--
-- 'imported_archive_high' and 'imported_archive_low' are also KEPT. Discovery
-- will not write them again, but four rows from run 328349c2 hold
-- imported_archive_low and those rows are true — that is what happened.
--
-- Touches no row: this widens the constraint only.
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
    -- Measured, and cached instead of imported
    'rejected_below_floor',   -- below the band minimum
    'rejected_above_max',     -- above the band maximum
    -- Legacy: written before Discovery stopped archiving. Not produced now.
    'imported_archive_high',
    'imported_archive_low'
  ));

COMMIT;
