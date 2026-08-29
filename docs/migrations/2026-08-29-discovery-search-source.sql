-- ============================================================================
-- discovery_runs.search_source
--
-- No placeholders. Safe to paste whole.
--
-- WHY A COLUMN AND NOT A discovery_mode VALUE
--
-- discovery_mode is what the run is FOR (niche / sponsorship). search_source is
-- what the terms ARE (hashtag / keyword). They are orthogonal: a niche run can
-- search either, and so could a sponsorship run. Adding 'keyword' as a third
-- discovery_mode value would make a keyword niche run indistinguishable from a
-- hashtag niche run — it would answer one question by destroying the answer to
-- the other. Two dimensions need two columns.
--
-- BACKFILLED, unlike discovery_runs.platform
--
-- platform was left NULL on existing rows because both platforms existed and we
-- genuinely did not know which each run used. search_source is different:
-- keyword search did not exist before this change, so every historical run was
-- a hashtag run by construction. Backfilling is a statement of fact, not a
-- guess, and it lets queries read the column directly instead of wrapping every
-- reference in coalesce().
-- ============================================================================

BEGIN;

ALTER TABLE discovery_runs ADD COLUMN IF NOT EXISTS search_source text;

UPDATE discovery_runs SET search_source = 'hashtag' WHERE search_source IS NULL;

-- The default covers callers that do not set it — the legacy save-discovery-run
-- route, still used by unconverted Sponsorship mode, is one.
ALTER TABLE discovery_runs ALTER COLUMN search_source SET DEFAULT 'hashtag';
ALTER TABLE discovery_runs ALTER COLUMN search_source SET NOT NULL;

-- Closed two-value taxonomy, constrained for the same reason
-- discovery_candidates.outcome is: a typo would not error, it would quietly
-- form a third category that every GROUP BY reports as its own row.
--
-- Widening later is DROP CONSTRAINT + ADD CONSTRAINT in one transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'discovery_runs_search_source_check'
  ) THEN
    ALTER TABLE discovery_runs
      ADD CONSTRAINT discovery_runs_search_source_check
      CHECK (search_source IN ('hashtag', 'keyword'));
  END IF;
END $$;

COMMIT;
