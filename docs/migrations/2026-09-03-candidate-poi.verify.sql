-- Verification for 2026-09-03-candidate-poi.sql
-- Read-only. Run after applying. Nothing here writes.
--
-- NOTE: the Supabase SQL editor shows only the LAST statement's result. Run
-- statement 1 on its own, or use the single-row version at the bottom.

-- 1. The three columns exist, are text, and are nullable. Expect three rows.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'discovery_candidates'
  AND column_name IN ('poi_name', 'poi_address', 'poi_city_code')
ORDER BY column_name;

-- 2. NO EXISTING ROW WAS TOUCHED. Expect 0 — nothing has run yet.
SELECT count(*) AS expect_0
FROM discovery_candidates
WHERE poi_name IS NOT NULL OR poi_address IS NOT NULL OR poi_city_code IS NOT NULL;

-- ── Everything in one row, for the Supabase editor ────────────────────────
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='discovery_candidates'
       AND column_name IN ('poi_name','poi_address','poi_city_code'))     AS expect_3_columns,
  (SELECT count(*) FROM pg_indexes
     WHERE tablename='discovery_candidates'
       AND indexname='discovery_candidates_poi_name_idx')                 AS expect_1_index,
  (SELECT count(*) FROM discovery_candidates WHERE poi_name IS NOT NULL)  AS expect_0_until_run,
  (SELECT count(*) FROM discovery_candidates)                             AS total_rows_unchanged;

-- ── After the first keyword run on the new actor ──────────────────────────
-- What does poi actually contain? This is the question the columns exist to
-- answer. Expect roughly a quarter of tiktok/keyword rows to carry one.
SELECT
  count(*)                                    AS candidates,
  count(poi_name)                             AS with_poi,
  round(100.0 * count(poi_name) / nullif(count(*),0), 1) AS poi_pct
FROM discovery_candidates
WHERE platform = 'tiktok';

SELECT poi_name, poi_address, count(*) AS n
FROM discovery_candidates
WHERE poi_name IS NOT NULL
GROUP BY poi_name, poi_address
ORDER BY n DESC
LIMIT 40;
