-- ============================================================================
-- Verification for 2026-08-28-discovery-candidates.sql
--
-- No placeholders. Safe to paste whole.
-- ============================================================================

-- 1. Columns. Expect 9 rows: id, run_id, hashtag, platform, handle, outcome,
--    follower_count, logged_at, measured_at
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'discovery_candidates'
ORDER BY ordinal_position;

-- 2. Constraints. Expect measurement_paired (c), outcome_check (c),
--    pkey (p), run_handle_unique (u), run_id_fkey (f)
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'discovery_candidates'::regclass
ORDER BY conname;

-- 3. Indexes. Expect platform_handle_idx and run_idx, plus the primary key
--    and the unique index backing run_handle_unique.
SELECT indexname FROM pg_indexes
WHERE tablename = 'discovery_candidates'
ORDER BY indexname;

-- 4. discovery_runs gained two nullable columns. Expect 2 rows.
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'discovery_runs'
  AND column_name IN ('platform', 'last_progress_at');

-- 5. The existing runs are untouched. Expect 62 / 62 / 62 / 53 / 9.
SELECT
  count(*)                                         AS total_runs,
  count(*) FILTER (WHERE platform IS NULL)         AS null_platform,
  count(*) FILTER (WHERE last_progress_at IS NULL) AS null_last_progress,
  count(*) FILTER (WHERE status = 'complete')      AS status_complete,
  count(*) FILTER (WHERE status = 'completed')     AS status_completed
FROM discovery_runs;

-- 6. The new table is empty. Expect 0.
SELECT count(*) AS candidates FROM discovery_candidates;
