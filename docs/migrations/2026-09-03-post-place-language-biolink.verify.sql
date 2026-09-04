-- Verification for 2026-09-03-post-place-language-biolink.sql. Read-only.
-- One row on purpose: the Supabase editor shows only the LAST result.

SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_name='creator_posts'
     AND column_name IN ('place_city_code','place_country_code','place_name',
                         'place_address','place_city','post_language'))        AS expect_6_post_cols,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='social_profiles'
     AND column_name IN ('place_city_code','place_country_code','place_name',
                         'place_confidence','place_tagged_posts','place_total_posts',
                         'post_language','post_language_confidence','post_languages',
                         'bio_link'))                                          AS expect_10_profile_cols,
  (SELECT count(*) FROM pg_indexes WHERE indexname IN
     ('creator_posts_place_city_code_idx','social_profiles_place_country_code_idx',
      'social_profiles_post_language_idx'))                                    AS expect_3_indexes,
  (SELECT count(*) FROM creator_posts   WHERE place_city_code IS NOT NULL
                                           OR post_language   IS NOT NULL)     AS expect_0_until_reenrich,
  (SELECT count(*) FROM social_profiles WHERE place_city_code IS NOT NULL
                                           OR post_language   IS NOT NULL)     AS expect_0_profiles,
  (SELECT count(*) FROM creator_posts)                                         AS posts_unchanged,
  (SELECT count(*) FROM social_profiles)                                       AS profiles_unchanged;

-- ── After re-enriching a TikTok batch ─────────────────────────────────────
-- Expect ~8% of posts placed, ~99% with a language, ~15% of creators to clear
-- the place bar.
--
-- SELECT count(*) AS posts,
--        count(place_city_code) AS placed,
--        count(post_language)   AS with_language
-- FROM creator_posts WHERE platform='tiktok';
--
-- SELECT place_country_code, place_city_code, place_name,
--        count(*) AS creators, round(avg(place_confidence)::numeric,2) AS avg_conf
-- FROM social_profiles WHERE place_city_code IS NOT NULL
-- GROUP BY 1,2,3 ORDER BY creators DESC;
--
-- The comparison the separate columns exist for — actor vs heuristic:
-- SELECT post_language, detected_language, count(*) AS creators
-- FROM social_profiles
-- WHERE post_language IS NOT NULL AND detected_language IS NOT NULL
-- GROUP BY 1,2 ORDER BY creators DESC;
