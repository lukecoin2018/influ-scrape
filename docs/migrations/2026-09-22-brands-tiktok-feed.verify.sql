-- Verification for 2026-09-22-brands-tiktok-feed.sql
-- Read-only. Run after applying. Nothing here writes.
--
-- NOTE: the Supabase SQL editor shows only the LAST statement's result. Run
-- each statement on its own, or use the single-row version at the bottom.

-- 1. Both columns exist and are nullable. Expect two rows:
--    tiktok_feed_post_count integer / tiktok_feed_scraped_at timestamp with
--    time zone, both is_nullable 'YES'.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'brands'
  AND column_name IN ('tiktok_feed_scraped_at', 'tiktok_feed_post_count')
ORDER BY column_name;

-- 2. The index exists. Expect one row.
SELECT indexname FROM pg_indexes
WHERE tablename = 'brands'
  AND indexname = 'brands_tiktok_feed_scraped_at_idx';

-- 3. NO EXISTING ROW WAS TOUCHED. Expect 0 and 0 — nothing has run yet.
SELECT
  count(*) FILTER (WHERE tiktok_feed_scraped_at IS NOT NULL) AS expect_0_scraped,
  count(*) FILTER (WHERE tiktok_feed_post_count IS NOT NULL) AS expect_0_count
FROM brands;

-- 4. The Instagram pair is untouched. Compare against the counts taken before
--    applying (803 stamped on 2026-09-22).
SELECT
  count(*)                                        AS brands_total,
  count(*) FILTER (WHERE feed_scraped_at IS NOT NULL) AS instagram_stamped_unchanged
FROM brands;

-- ── Everything in one row, for the Supabase editor ────────────────────────
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'brands'
       AND column_name IN ('tiktok_feed_scraped_at', 'tiktok_feed_post_count')) AS expect_2_columns,
  (SELECT count(*) FROM pg_indexes
     WHERE tablename = 'brands'
       AND indexname = 'brands_tiktok_feed_scraped_at_idx')                     AS expect_1_index,
  (SELECT count(*) FROM brands WHERE tiktok_feed_scraped_at IS NOT NULL)         AS expect_0_until_run,
  (SELECT count(*) FROM brands)                                                  AS total_rows_unchanged;

-- ── After the first TikTok brand-feed run ─────────────────────────────────
-- Which brands were stamped, and what the actor returned for each. A
-- tiktok_feed_post_count of 0 is the "caption token is not the account"
-- signal described in the migration.
SELECT instagram_handle, tiktok_handle, tiktok_feed_scraped_at, tiktok_feed_post_count,
       feed_scraped_at AS instagram_feed_scraped_at
FROM brands
WHERE tiktok_feed_scraped_at IS NOT NULL
ORDER BY tiktok_feed_scraped_at DESC;
