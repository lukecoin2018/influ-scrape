-- ============================================================================
-- OPTIONAL: mark the four seeds already expanded by hand on 2026-09-04
--
-- No placeholders. Safe to paste whole. Run AFTER
-- 2026-09-05-seed-expansion.sql, or the column will not exist.
--
-- WHY THIS IS NEEDED
--
-- colgo, anni_jara, daniblog133 and camila_mirasmithb were expanded through
-- the Apify console during the measurement work, not through the application,
-- so nothing wrote seed_expanded_at for them. Without this they reappear in
-- the seed queue and a second traversal pays ~$0.20 each for following lists
-- already fetched. The known-handle filter would reject the candidates for
-- free, so the waste is the traversal only — real, but small.
--
-- SKIP THIS IF you would rather re-traverse them: their lists may have grown
-- since 2026-09-04, and camila_mirasmithb follows only 16, so its list is
-- cheap to refresh. This is a preference, not a correctness issue.
--
-- SCOPED TO FOUR EXPLICIT HANDLES. No subquery, no NOT EXISTS, no join. The
-- SELECT below carries the IDENTICAL WHERE clause as the UPDATE — run it
-- first, read the four rows, then run the UPDATE.
-- See docs/incident-2026-08-29-unscoped-delete.md.
-- ============================================================================

-- ── STEP 1. Read what will change. Expect EXACTLY 4 rows, all with
--            seed_expanded_at NULL. If you see 3, or 5, or a non-null value,
--            STOP and find out why before running step 2.
SELECT handle, platform, import_status, following_count, seed_expanded_at
FROM social_profiles
WHERE platform = 'tiktok'
  AND handle IN ('colgo', 'anni_jara', 'daniblog133', 'camila_mirasmithb');

-- ── STEP 2. The write. IDENTICAL WHERE clause to step 1.
--            The timestamp is the date they were actually traversed, not now:
--            the column records when the list was fetched, and backdating it
--            keeps that true.
BEGIN;

UPDATE social_profiles
SET seed_expanded_at = timestamptz '2026-09-04 19:20:00+00'
WHERE platform = 'tiktok'
  AND handle IN ('colgo', 'anni_jara', 'daniblog133', 'camila_mirasmithb');

-- ── STEP 3. Confirm 4 before committing. If this is not 4, ROLLBACK.
SELECT count(*) AS marked
FROM social_profiles
WHERE platform = 'tiktok'
  AND handle IN ('colgo', 'anni_jara', 'daniblog133', 'camila_mirasmithb')
  AND seed_expanded_at IS NOT NULL;

COMMIT;
