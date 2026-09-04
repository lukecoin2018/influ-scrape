-- ============================================================================
-- Null the "0" city-code sentinel written before the extractor was fixed
--
-- No placeholders. Safe to paste whole. Scoped to a literal value.
--
-- The actor sends the literal string "0" as cityCode on COUNTRY-LEVEL tags —
-- it tagged a country and named no city. Confirmed from the raw dataset:
--
--   {"address":"British Virgin Islands","city":"","cityCode":"0",
--    "countryCode":"3577718","locationName":"Spanish Town"}
--
-- GeoNames ids start at 1, so "0" cannot be a place. Stored as a VALUE rather
-- than an absence it collapses every country-level creator on earth into one
-- bogus "city 0" bucket in any GROUP BY.
--
-- lib/postLocation.ts now maps "0" to null on extraction, and gained a
-- country-level fallback so these creators still resolve — nulling the code
-- alone would have discarded a correct answer. This repairs the rows written
-- by the first re-enrich, before the fix.
--
-- Measured 2026-09-03: 3 creator_posts rows, 1 social_profiles row. No DELETE;
-- values are nulled in place and the country code is untouched, so
-- @donnacayman keeps its British Virgin Islands answer at country level.
-- ============================================================================

BEGIN;

-- 1. Run this SELECT first. Expect 3 rows, all with a country code present.
SELECT id, place_city_code, place_country_code, place_name
FROM creator_posts
WHERE place_city_code = '0';

UPDATE creator_posts
SET place_city_code = NULL
WHERE place_city_code = '0';

-- 2. Run this SELECT first. Expect 1 row: donnacayman / 3577718.
SELECT id, handle, place_city_code, place_country_code, place_confidence, place_tagged_posts
FROM social_profiles
WHERE place_city_code = '0';

UPDATE social_profiles
SET place_city_code = NULL
WHERE place_city_code = '0';

COMMIT;

-- ── Verification, after COMMIT ─────────────────────────────────────────────
-- Expect 0, 0, and donnacayman still present with its country intact.
SELECT
  (SELECT count(*) FROM creator_posts   WHERE place_city_code = '0') AS expect_0_posts,
  (SELECT count(*) FROM social_profiles WHERE place_city_code = '0') AS expect_0_profiles,
  (SELECT count(*) FROM social_profiles
     WHERE place_country_code IS NOT NULL AND place_city_code IS NULL) AS country_level_creators;
