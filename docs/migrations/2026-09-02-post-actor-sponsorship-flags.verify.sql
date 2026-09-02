-- Verification for 2026-09-02-post-actor-sponsorship-flags.sql
-- Read-only. Run after applying. Nothing here writes.

-- 1. Both columns exist, are boolean, and are nullable. Expect two rows,
--    data_type 'boolean', is_nullable 'YES'.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'creator_posts'
  AND column_name IN ('actor_is_sponsored', 'actor_is_ad')
ORDER BY column_name;

-- 2. The index exists. Expect one row.
SELECT indexname FROM pg_indexes
WHERE tablename = 'creator_posts'
  AND indexname = 'creator_posts_actor_is_sponsored_true_idx';

-- 3. NO EXISTING ROW WAS TOUCHED. Every pre-existing row must still be NULL on
--    both columns, because nothing has re-enriched yet. Expect 0 and 0.
SELECT
  count(*) FILTER (WHERE actor_is_sponsored IS NOT NULL) AS expect_0_sponsored,
  count(*) FILTER (WHERE actor_is_ad IS NOT NULL)        AS expect_0_ad
FROM creator_posts;

-- 4. Row count unchanged. Compare against the count taken before applying.
SELECT count(*) AS creator_posts_total FROM creator_posts;

-- ── After re-enriching a TikTok batch, this is the comparison ──────────────
--
-- The whole point of the two columns. Run it once new rows exist.

SELECT
  actor_is_sponsored,
  is_sponsored          AS detector_says,
  count(*)              AS posts,
  count(*) FILTER (WHERE detected_brands <> '{}') AS with_brands
FROM creator_posts
WHERE platform = 'tiktok'
  AND actor_is_sponsored IS NOT NULL
GROUP BY actor_is_sponsored, is_sponsored
ORDER BY actor_is_sponsored DESC, detector_says DESC;

-- Posts the actor flagged, the detector missed, and that still carry a mention
-- worth extracting. On the 886-item sample 44% of these had a recoverable
-- brand handle in detailedMentions.
SELECT count(*) AS flagged_missed_with_tags
FROM creator_posts
WHERE platform = 'tiktok'
  AND actor_is_sponsored IS TRUE
  AND is_sponsored IS FALSE
  AND tagged_accounts <> '{}';
