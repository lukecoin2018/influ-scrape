-- ============================================================================
-- Backfill creators.full_name for TikTok creators
--
-- No placeholders. Safe to paste whole.
--
-- mapTikTokProfile read `displayName`, which abe/tiktok-profile-scraper does
-- not emit; the display name arrived as `tagline` and was written into
-- social_profiles.platform_data->>'tagline' while full_name was left null.
-- 3,457 of 3,458 TikTok-primary creators are affected.
--
-- Recoverable without re-scraping, because the value is already stored.
--
-- Only rows where full_name IS NULL are touched, so this is idempotent and
-- cannot overwrite a name entered by hand. display_name is left alone: it
-- currently holds the handle, which is a reasonable fallback, and changing it
-- would alter what the Creators table shows for rows an operator may have
-- already curated.
-- ============================================================================

BEGIN;

UPDATE creators c
SET full_name = NULLIF(TRIM(sp.platform_data->>'tagline'), '')
FROM social_profiles sp
WHERE sp.creator_id = c.id
  AND sp.platform = 'tiktok'
  AND c.full_name IS NULL
  AND NULLIF(TRIM(sp.platform_data->>'tagline'), '') IS NOT NULL;

-- Archived creators live in a separate table and are covered by the same gap.
UPDATE creators_archive c
SET full_name = NULLIF(TRIM(sp.platform_data->>'tagline'), '')
FROM social_profiles_archive sp
WHERE sp.creator_id = c.id
  AND sp.platform = 'tiktok'
  AND c.full_name IS NULL
  AND NULLIF(TRIM(sp.platform_data->>'tagline'), '') IS NOT NULL;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
-- Before: full_name_set = 1. After: expect it to approach total_tiktok.
SELECT
  count(*)                              AS total_tiktok,
  count(*) FILTER (WHERE full_name IS NOT NULL) AS full_name_set,
  count(*) FILTER (WHERE full_name IS NULL)     AS still_null
FROM creators
WHERE primary_platform = 'tiktok';
