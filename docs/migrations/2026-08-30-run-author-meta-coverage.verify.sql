-- ============================================================================
-- Verification for 2026-08-30-run-author-meta-coverage.sql
-- No placeholders. Safe to paste whole. Read-only.
-- ============================================================================

-- 1. The column exists and is nullable jsonb. Expect one row.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'discovery_runs' AND column_name = 'author_meta_coverage';

-- 2. Every existing run is untouched: NULL on all of them.
SELECT count(*)                                             AS total_runs,
       count(*) FILTER (WHERE author_meta_coverage IS NULL) AS null_coverage
FROM discovery_runs;

-- 3. After the next TikTok run, this reads the per-term coverage back.
SELECT id, hashtags, search_source, jsonb_pretty(author_meta_coverage)
FROM discovery_runs
WHERE author_meta_coverage IS NOT NULL
ORDER BY started_at DESC
LIMIT 3;
