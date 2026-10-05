-- Verification for 2026-09-22-partnerships-platform.sql
-- Read-only. Run after applying. Nothing here writes.
--
-- NOTE: the Supabase SQL editor shows only the LAST statement's result. Run
-- each statement on its own, or use the single-row version at the bottom.

-- 1. The column exists, is NOT NULL, and defaults to 'instagram'. Expect one
--    row: data_type 'character varying', is_nullable 'NO',
--    column_default '''instagram''::character varying'.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'partnerships'
  AND column_name = 'platform';

-- 2. The CHECK exists and names both values. Expect one row whose definition
--    reads CHECK (((platform)::text = ANY (...'instagram'...'tiktok'...))).
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'partnerships'::regclass
  AND conname = 'partnerships_platform_check';

-- 3. The index exists. Expect one row.
SELECT indexname FROM pg_indexes
WHERE tablename = 'partnerships'
  AND indexname = 'partnerships_brand_platform_idx';

-- 4. The unique index is UNTOUCHED. Expect one row, on exactly
--    (creator_id, brand_id, post_url).
SELECT indexdef FROM pg_indexes
WHERE tablename = 'partnerships'
  AND indexname = 'partnerships_unique_creator_brand_post';

-- 5. EVERY EXISTING ROW IS instagram AND NONE IS tiktok. Expect the instagram
--    count to equal the total (9,791 when this was written) and tiktok 0 —
--    nothing has run on TikTok yet.
SELECT
  count(*)                                       AS total,
  count(*) FILTER (WHERE platform = 'instagram') AS expect_equal_to_total,
  count(*) FILTER (WHERE platform = 'tiktok')    AS expect_0_until_run
FROM partnerships;

-- ── Everything in one row, for the Supabase editor ────────────────────────
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name = 'partnerships' AND column_name = 'platform'
       AND is_nullable = 'NO')                                          AS expect_1_column_not_null,
  (SELECT count(*) FROM pg_constraint
     WHERE conrelid = 'partnerships'::regclass
       AND conname = 'partnerships_platform_check')                     AS expect_1_check,
  (SELECT count(*) FROM pg_indexes
     WHERE tablename = 'partnerships'
       AND indexname = 'partnerships_brand_platform_idx')               AS expect_1_index,
  (SELECT count(*) FROM pg_indexes
     WHERE tablename = 'partnerships'
       AND indexname = 'partnerships_unique_creator_brand_post')        AS expect_1_unique_index_unchanged,
  (SELECT count(*) FROM partnerships)                                   AS total_rows_unchanged,
  (SELECT count(*) FROM partnerships WHERE platform = 'instagram')      AS expect_equal_to_total,
  (SELECT count(*) FROM partnerships WHERE platform = 'tiktok')         AS expect_0_until_run;

-- ── After the first TikTok brand-feed run ─────────────────────────────────
-- The number the run is judged on: edges per platform, and per brand.
SELECT platform, count(*) FROM partnerships GROUP BY 1 ORDER BY 1;

SELECT b.instagram_handle, p.platform, count(*) AS edges,
       count(DISTINCT p.creator_id) AS creators,
       min(p.posted_at) AS oldest_post, max(p.posted_at) AS newest_post
FROM partnerships p
JOIN brands b ON b.id = p.brand_id
WHERE p.platform = 'tiktok'
GROUP BY 1, 2
ORDER BY edges DESC;
