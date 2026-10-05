-- ============================================================================
-- brands gains a TikTok feed-scrape stamp
--
-- No placeholders. Safe to paste whole. Touches no existing row.
--
-- WHY
--
-- brands.feed_scraped_at (20260825000001) and feed_post_count (20260826000003)
-- record the last scrape of the brand's OWN INSTAGRAM FEED, and the queue's
-- "never scraped" / "stale first" orderings sort on them. A TikTok feed scrape
-- stamping the same column would pull the brand out of the Instagram
-- never-scraped pool, and the Instagram scrape would do the reverse;
-- feed_post_count would flip between platforms with the latest reading
-- winning. One timestamp cannot record two feeds.
--
-- WHY TWO FLAT COLUMNS AND NOT JSON OR A RUNS TABLE
--
-- The queue sorts NULLS FIRST on the raw column with no special-casing
-- (20260825000001), and lib/brandFeedQueue.ts selects the pair by platform.
-- Flat columns keep that query shape and are indexable without a JSON path,
-- the same reasoning as 2026-09-03-candidate-poi. A brand_feed_runs table
-- would be a run log, which this pipeline does not have, and would still need
-- the per-brand "last scraped on this platform" denormalised back here for the
-- ordering — so it does not remove the need for these columns.
--
-- The existing pair keeps its name and its Instagram meaning: renaming it
-- would touch every reader for no gain, and its column comment already says
-- "Instagram feed".
--
-- NULL SEMANTICS, same as the Instagram pair: tiktok_feed_scraped_at NULL =
-- never scraped on TikTok. tiktok_feed_post_count NULL = never scraped;
-- 0 = scraped and the actor returned nothing (a dormant, renamed or wrong
-- handle — on TikTok, tiktok_handle is the caption token the brand was
-- mentioned by, never verified against TikTok, so 0 here is the first signal
-- that the token is not the account).
-- ============================================================================

BEGIN;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS tiktok_feed_scraped_at timestamptz;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS tiktok_feed_post_count integer;

COMMENT ON COLUMN brands.tiktok_feed_scraped_at IS
  'Last time this brand''s own TikTok feed was scraped for creator collaborations. NULL = never scraped on TikTok. Written only by the brand-feed pipeline on a TikTok run; feed_scraped_at is the Instagram equivalent and the two are independent.';

COMMENT ON COLUMN brands.tiktok_feed_post_count IS
  'Posts returned by the most recent TikTok brand-feed scrape. NULL = never scraped on TikTok; 0 = scraped and the actor returned nothing, which on TikTok usually means tiktok_handle is a caption token and not the account. Advisory only — nothing filters on it unless the operator opts in.';

-- NULLS FIRST matches the queue ordering, as brands_feed_scraped_at_idx does.
CREATE INDEX IF NOT EXISTS brands_tiktok_feed_scraped_at_idx
  ON brands (tiktok_feed_scraped_at NULLS FIRST);

COMMIT;
