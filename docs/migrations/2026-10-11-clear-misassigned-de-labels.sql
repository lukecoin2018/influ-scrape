-- ============================================================================
-- Clear the German language label on two creators who do not write German
--
-- No placeholders. Safe to paste whole. Scoped to two literal ids per table,
-- and guarded on the value still being 'de'.
--
-- The 2026-10-11 Portuguese backfill (scripts/backfill-pt-language.mjs)
-- replaced each stale 'pt' label with the corrected heuristic's answer. For
-- two creators that answer is 'de', and it is wrong:
--
--   @moyamatchapl (instagram)  Polish     "Japońska matcha, ceramika, herbaty i akcesoria"
--   @_.getrex._   (tiktok)     Hungarian  "-10% 'GETREX' kuponkóddal"
--
-- The heuristic has no Polish or Hungarian stopword list, so a stray "die" or
-- "das" lands them on German (deferred-cleanups item 41). Both carried 'pt'
-- before the backfill, wrong too. Cleared rather than set: the heuristic
-- cannot name either language, and no TikTok post language exists for them.
--
-- Matters because German labels feed the DACH-or-German set. Each creator has
-- one social profile, so creators.primary_language mirrors it exactly.
--
-- NOT STICKY. @_.getrex._ is in the "Needs re-analysis" queue (re-enriched
-- since its last analysis); running that mode writes 'de' again, as would
-- "Re-analyze all" for either. Item 41 is the fix for that.
-- ============================================================================

BEGIN;

-- 1. Run this SELECT first. Expect 2 rows, both detected_language = 'de'.
SELECT id, handle, platform, detected_language
FROM social_profiles
WHERE id IN ('05f8db2d-e6f5-41ae-98c7-71e4c5ad5222', '3b6ef016-7dc4-4020-bdd5-7583cae545f7');

UPDATE social_profiles
SET detected_language = NULL
WHERE id IN ('05f8db2d-e6f5-41ae-98c7-71e4c5ad5222', '3b6ef016-7dc4-4020-bdd5-7583cae545f7')
  AND detected_language = 'de';

-- 2. Run this SELECT first. Expect 2 rows, both primary_language = 'de'.
SELECT id, primary_language, ai_embedded
FROM creators
WHERE id IN ('8da43e98-bfa7-4b2a-86bc-cb018a357af9', 'cb21cf70-7b0e-4bb3-b9d8-5a27f0c81868');

-- ai_embedded = false, as an Intelligence pass does: the embedding text
-- carries the language.
UPDATE creators
SET primary_language = NULL,
    ai_embedded = false
WHERE id IN ('8da43e98-bfa7-4b2a-86bc-cb018a357af9', 'cb21cf70-7b0e-4bb3-b9d8-5a27f0c81868')
  AND primary_language = 'de';

COMMIT;

-- ── Verification, after COMMIT ─────────────────────────────────────────────
-- Expect 0 and 0: neither row carries a language any more.
SELECT
  (SELECT count(*) FROM social_profiles
     WHERE id IN ('05f8db2d-e6f5-41ae-98c7-71e4c5ad5222', '3b6ef016-7dc4-4020-bdd5-7583cae545f7')
       AND detected_language IS NOT NULL) AS expect_0_profiles,
  (SELECT count(*) FROM creators
     WHERE id IN ('8da43e98-bfa7-4b2a-86bc-cb018a357af9', 'cb21cf70-7b0e-4bb3-b9d8-5a27f0c81868')
       AND primary_language IS NOT NULL) AS expect_0_creators;
