-- ============================================================================
-- OPTIONAL cleanup: remove the four archive rows Discovery wrote before it
-- stopped archiving.
--
-- No placeholders. Safe to paste whole. NOT required — the rows are harmless,
-- nothing reads the archive, and leaving them costs nothing but tidiness.
--
-- Run this only if you want the archive to contain brand-feed candidates
-- exclusively, which is what its semantics now say it holds.
--
-- The four rows, all from run 328349c2 / #fashionblogger, all archive_reason
-- 'below_min':
--
--   @nitchakitty            20,422
--   @your__boho_girl        15,520
--   @simply_nasi            18,495
--   @bhajubajuku.official   28,764
--
-- Their discovery_candidates rows are LEFT ALONE. They record what happened at
-- the time and still read 'imported_archive_low', which was true. Deleting the
-- archive rows does not make that history false.
--
-- After this, those four handles have no creator record. They are not in the
-- reject cache either, since they were imported rather than cached. A future
-- run will re-scrape them once, measure them, and cache them properly — one
-- scrape each, about $0.01 in total.
-- ============================================================================

BEGIN;

-- Profiles first: creators_archive rows are referenced by them.
DELETE FROM social_profiles_archive
WHERE platform = 'instagram'
  AND NOT (discovered_via_hashtags @> ARRAY['brand_feed'])
  AND handle IN ('nitchakitty', 'your__boho_girl', 'simply_nasi', 'bhajubajuku.official');

-- Then any creators_archive row left with no profile beneath it.
DELETE FROM creators_archive c
WHERE NOT EXISTS (
  SELECT 1 FROM social_profiles_archive sp WHERE sp.creator_id = c.id
) AND NOT EXISTS (
  SELECT 1 FROM social_profiles sp WHERE sp.creator_id = c.id
);

COMMIT;

-- Expect 1496 and 1497 — brand-feed's rows, untouched.
SELECT
  (SELECT count(*) FROM social_profiles_archive) AS profiles_archive,
  (SELECT count(*) FROM creators_archive)        AS creators_archive;
