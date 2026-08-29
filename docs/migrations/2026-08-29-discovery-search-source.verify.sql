-- ============================================================================
-- Verification for 2026-08-29-discovery-search-source.sql
-- No placeholders. Safe to paste whole.
-- ============================================================================

-- 1. The column exists, is NOT NULL, and defaults to 'hashtag'.
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'discovery_runs' AND column_name = 'search_source';

-- 2. The CHECK constraint is present.
SELECT conname, contype FROM pg_constraint
WHERE conrelid = 'discovery_runs'::regclass
  AND conname = 'discovery_runs_search_source_check';

-- 3. Every existing run reads 'hashtag'. Expect one row: hashtag, 62
--    (or 62 plus whatever hashtag runs have happened since).
SELECT search_source, count(*) FROM discovery_runs GROUP BY search_source;

-- 4. The other columns are untouched — same figures as the previous migration.
SELECT
  count(*)                                         AS total_runs,
  count(*) FILTER (WHERE platform IS NULL)         AS null_platform,
  count(*) FILTER (WHERE status = 'complete')      AS status_complete,
  count(*) FILTER (WHERE status = 'completed')     AS status_completed
FROM discovery_runs;
