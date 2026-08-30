-- ============================================================================
-- Verification for 2026-08-29-discovery-reject-above-max.sql
-- No placeholders. Safe to paste whole.
-- ============================================================================

-- 1. The constraint exists. Expect one row.
SELECT conname, contype FROM pg_constraint
WHERE conrelid = 'discovery_candidates'::regclass
  AND conname = 'discovery_candidates_outcome_check';

-- 2. Every existing row still validates — nothing was rewritten.
--    Expect the same distribution as before: rejected_below_floor 131,
--    imported_active 11, imported_archive_low 4, unknown_size 4,
--    cached_reject 4, and zero rejected_above_max until the next run.
SELECT outcome, count(*) FROM discovery_candidates GROUP BY outcome ORDER BY outcome;

-- 3. The four archive rows Discovery wrote before this change, for reference.
--    Cleanup is optional and is a separate file.
SELECT sp.handle, sp.follower_count, sp.archive_reason, sp.discovered_via_hashtags
FROM social_profiles_archive sp
WHERE NOT (sp.discovered_via_hashtags @> ARRAY['brand_feed'])
ORDER BY sp.follower_count;
