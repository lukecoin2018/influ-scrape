-- ============================================================================
-- Verification for 2026-09-06-seed-retrievability.sql
-- No placeholders. Safe to paste whole. Read-only — nothing here writes.
-- ============================================================================

-- 1. The three columns exist and are nullable with no default.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'social_profiles'
  AND column_name IN ('seed_following_retrievable', 'seed_last_attempt_at', 'seed_last_attempt_note')
ORDER BY column_name;

-- 2. Nothing has been judged yet. Expect 0, 0, 0.
SELECT
  count(*) FILTER (WHERE seed_following_retrievable IS TRUE)  AS retrievable_true,
  count(*) FILTER (WHERE seed_following_retrievable IS FALSE) AS retrievable_false,
  count(*) FILTER (WHERE seed_last_attempt_at IS NOT NULL)    AS attempted
FROM social_profiles;

-- 3. The index carries the new predicate. The definition must contain
--    "seed_following_retrievable IS DISTINCT FROM false".
SELECT indexdef FROM pg_indexes
WHERE tablename = 'social_profiles' AND indexname = 'social_profiles_seed_queue_idx';

-- 4. seed_expanded_at is untouched: still exactly the four hand-marked seeds.
--    ramecabrera must NOT appear — it was unburned on 2026-09-05.
SELECT handle, seed_expanded_at
FROM social_profiles
WHERE seed_expanded_at IS NOT NULL
ORDER BY handle;

-- 5. The queue, unchanged in size by this migration because nothing is false
--    yet. Compare against the figures recorded after the first migration:
--    en 612, es 119, plus the long tail.
SELECT post_language, count(*) AS seeds_available
FROM social_profiles
WHERE platform = 'tiktok'
  AND import_status = 'active'
  AND seed_expanded_at IS NULL
  AND seed_following_retrievable IS DISTINCT FROM false
  AND post_language IS NOT NULL
  AND following_count >= 150
GROUP BY post_language
ORDER BY seeds_available DESC;
