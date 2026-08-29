-- ============================================================================
-- OPTIONAL: remove C8's 11 imported creators
--
-- No placeholders. Safe to paste whole.
--
-- WHAT A CREATOR ROW TOUCHES — measured, not assumed:
--
--   creator_posts   (FK social_profile_id)  ->  0 rows for these 11
--   partnerships    (FK creator_id)         ->  0 rows for these 11
--   creators                                ->  11, one per profile
--   embeddings (creators.embedded_at)       ->  0 of 11 embedded
--
-- None were enriched, so there are no posts, no engagement metrics, no AI
-- summary, no detected country and no embedding. Nothing references them. This
-- is as clean as a deletion gets in this schema.
--
-- The 11, with the category Instagram itself reported at import time:
--
--   @__black__shop__        85,651   Clothing (Brand)
--   @basic.butnotbasic      62,744   Clothing (Brand)
--   @curly_spoon_           85,315   Digital creator
--   @ferida_showroom1      147,676   None
--   @fsateenm1             152,191   Clothing (Brand)
--   @hyren.co               85,610   Clothing (Brand)
--   @isakshiee_official     30,501   Digital creator
--   @mahadev_sarees_hatod   37,530   (none)
--   @susmita__aich         247,098   Reel creator
--   @the.good_taste        111,685   Blogger
--   @vrrockclo              43,975   Clothing (Brand)
--
-- Five were labelled Clothing (Brand) by Instagram and imported as active
-- anyway. The signal was in the profile payload at import time; nothing read it.
--
-- discovery_candidates rows are LEFT ALONE. They record that these handles were
-- found and imported, which is true, and they are the reject cache's memory —
-- deleting them would make a future run re-scrape all 11.
-- ============================================================================

BEGIN;

-- Profiles first: creators are referenced by them.
DELETE FROM social_profiles
WHERE platform = 'instagram'
  AND handle IN (
    'hyren.co', 'isakshiee_official', 'fsateenm1', 'susmita__aich',
    'ferida_showroom1', 'mahadev_sarees_hatod', 'the.good_taste',
    'vrrockclo', '__black__shop__', 'curly_spoon_', 'basic.butnotbasic'
  );

-- Then creators with no profile left beneath them, in either population.
DELETE FROM creators c
WHERE NOT EXISTS (SELECT 1 FROM social_profiles sp WHERE sp.creator_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM social_profiles_archive sp WHERE sp.creator_id = c.id);

COMMIT;

-- Expect social_profiles down by 11 and creators down by 11.
SELECT
  (SELECT count(*) FROM social_profiles) AS social_profiles,
  (SELECT count(*) FROM creators)        AS creators,
  (SELECT count(*) FROM social_profiles WHERE handle IN (
     'hyren.co','isakshiee_official','fsateenm1','susmita__aich','ferida_showroom1',
     'mahadev_sarees_hatod','the.good_taste','vrrockclo','__black__shop__',
     'curly_spoon_','basic.butnotbasic')) AS should_be_zero;
