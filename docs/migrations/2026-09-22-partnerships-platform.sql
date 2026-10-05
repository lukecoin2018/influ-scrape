-- ============================================================================
-- partnerships gains a platform
--
-- No placeholders. Safe to paste whole. Touches no existing row's meaning:
-- every existing row is an Instagram edge, and the default says so.
--
-- WHY
--
-- The brand-feed pipeline is gaining a TikTok side: scrape a brand's own
-- TikTok posts, read the accounts it @mentions (detailedMentions, the only
-- field that carries real usernames), import them, record the edges. An edge
-- written that way would land in this table indistinguishable from an
-- Instagram one, and two things read the table as if every row were Instagram:
--
--   - creator_follower_count is documented (20260826000004) as the creator's
--     INSTAGRAM follower count, and the casting profile bands it against one
--     follower range. A TikTok count in the same column would be banded as if
--     it were an Instagram count.
--   - status counts edges by discovery_source alone.
--
-- Deriving the platform from the creator's social_profiles row was considered
-- and rejected: partnerships.creator_id points at creator_registry, so the
-- join goes through v_social_profiles_all; it only works while no creator has
-- profiles on two platforms (true today, 0 of 8,711 — and named in
-- docs/deferred-cleanups.md item 14 as the trigger that ends it); and it
-- cannot say which platform's follower count the snapshot is. The edge should
-- carry the fact.
--
-- THE DEFAULT IS A STATEMENT OF FACT, NOT A GUESS
--
-- Measured 2026-09-22: 9,791 rows, all discovery_source = 'brand_feed', and
-- every creator_id resolves to an instagram profile in v_social_profiles_all.
-- The brand-feed process route has only ever resolved creators with
-- .eq('platform', 'instagram'). So NOT NULL DEFAULT 'instagram' backfills every
-- existing row correctly, exactly as discovery_source defaulted to 'hashtag'
-- for the writer that existed at the time (20260825000002).
--
-- THE UNIQUE INDEX IS UNCHANGED, DELIBERATELY
--
-- partnerships_unique_creator_brand_post (creator_id, brand_id, post_url) does
-- not need platform: post_url is a full URL and already differs by platform
-- (instagram.com/p/... against tiktok.com/@.../video/...), and the writer skips
-- posts that carry no URL. Adding platform to the arbiter would only let a
-- mislabelled duplicate in.
--
-- A closed CHECK, as discovery_candidates.outcome has: a typo would not error,
-- it would silently vanish from every per-platform count. Widening later is
-- DROP CONSTRAINT + ADD CONSTRAINT in one transaction; existing rows validate
-- against any superset.
-- ============================================================================

BEGIN;

ALTER TABLE partnerships
  ADD COLUMN IF NOT EXISTS platform varchar NOT NULL DEFAULT 'instagram';

ALTER TABLE partnerships
  DROP CONSTRAINT IF EXISTS partnerships_platform_check;

ALTER TABLE partnerships
  ADD CONSTRAINT partnerships_platform_check
  CHECK (platform IN ('instagram', 'tiktok'));

COMMENT ON COLUMN partnerships.platform IS
  'The platform the post that produced this edge was on, and therefore the platform creator_follower_count was read on. Every row written before 2026-09-22 is instagram; the brand-feed pipeline writes tiktok for edges read off a brand''s TikTok feed.';

-- Re-worded: the old text said "Instagram follower count", which stops being
-- true with this column.
COMMENT ON COLUMN partnerships.creator_follower_count IS
  'The creator''s follower count ON partnerships.platform at the time this edge was recorded. Snapshotted so the casting profile is a pure function of the edges and cannot drift as creators grow. NULL when the count could not be read.';

-- The casting profile and the status route read edges per brand and, from
-- now on, per platform.
CREATE INDEX IF NOT EXISTS partnerships_brand_platform_idx
  ON partnerships (brand_id, platform);

COMMIT;
