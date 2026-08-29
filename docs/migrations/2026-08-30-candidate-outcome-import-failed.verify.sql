-- ============================================================================
-- Verification for 2026-08-30-candidate-outcome-import-failed.sql
-- No placeholders. Safe to paste whole. Read-only.
-- ============================================================================

-- 1. The constraint exists.
SELECT conname, contype FROM pg_constraint
WHERE conrelid = 'discovery_candidates'::regclass
  AND conname = 'discovery_candidates_outcome_check';

-- 2. Every existing row still validates and nothing was rewritten.
--    Expect the same distribution as before, and zero import_failed.
SELECT outcome, count(*) FROM discovery_candidates GROUP BY outcome ORDER BY outcome;

-- 3. Row count unchanged. Expect 154.
SELECT count(*) AS candidates FROM discovery_candidates;
