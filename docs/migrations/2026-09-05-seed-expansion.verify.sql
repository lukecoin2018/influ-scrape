-- ============================================================================
-- Verification for 2026-09-05-seed-expansion.sql
-- No placeholders. Safe to paste whole. Read-only — nothing here writes.
-- ============================================================================

-- 1. The CHECK now admits three values and only three.
--    Expect: ((search_source = ANY (ARRAY['hashtag','keyword','seed'])))
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'discovery_runs'::regclass
  AND conname = 'discovery_runs_search_source_check';

-- 2. No existing run was disturbed. Expect the same figures as before the
--    migration: hashtag + keyword only, and zero seed runs so far.
SELECT search_source, count(*) FROM discovery_runs GROUP BY search_source ORDER BY 1;

-- 3. The column exists, is nullable, and has no default.
--    Expect: seed_expanded_at | YES | (null)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'social_profiles' AND column_name = 'seed_expanded_at';

-- 4. Nothing is marked expanded yet. Expect 0.
SELECT count(*) AS already_marked
FROM social_profiles WHERE seed_expanded_at IS NOT NULL;

-- 5. The index exists.
SELECT indexname FROM pg_indexes
WHERE tablename = 'social_profiles' AND indexname = 'social_profiles_seed_queue_idx';

-- 6. The queue this was built for. These are the counts the SetupPanel will
--    show, so they are worth seeing once directly.
--
--    Measured before the migration, for comparison:
--      tiktok active                       3712
--      + following_count >= 150            2362
--      + post_language present              334   <- the real ceiling
--        of which es                         76
--        of which en                        235
--
--    post_language comes from enrichment, which has only run on a subset. That
--    is the binding constraint on this mechanism, not the follower threshold.
SELECT
  post_language,
  count(*) AS seeds_available,
  sum(following_count) AS following_total,
  round(avg(following_count)) AS following_avg
FROM social_profiles
WHERE platform = 'tiktok'
  AND import_status = 'active'
  AND seed_expanded_at IS NULL
  AND post_language IS NOT NULL
  AND following_count >= 150
GROUP BY post_language
ORDER BY seeds_available DESC;
