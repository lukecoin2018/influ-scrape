-- ============================================================================
-- discovery_candidates gains the free author signals
--
-- No placeholders. Safe to paste whole. Touches no existing row.
--
-- clockworks/tiktok-scraper returns author metadata ON THE SEARCH ITEM —
-- authorMeta.fans, signature, ttSeller, verified — so a follower count and two
-- business signals are available before any profile scrape. That moves the
-- follower band from the paid side of the line to the free side.
--
-- These columns record what those signals said, so the first run can report
-- what they WOULD have filtered before anything filters on them.
--
-- follower_count_source distinguishes the two ways a count can arrive. Both are
-- real measurements; one costs $0.005 and one is free. Without it a cached
-- rejection could not be told apart from a scraped one, and the difference
-- matters if the cheap reading ever turns out to be unreliable.
-- ============================================================================

BEGIN;

-- 'search_item'   read from the search result's author metadata, free
-- 'profile_scrape' read from a profile scrape, billed
ALTER TABLE discovery_candidates
  ADD COLUMN IF NOT EXISTS follower_count_source text;

-- TikTok Shop seller flag. A direct "this is a business" marker.
ALTER TABLE discovery_candidates
  ADD COLUMN IF NOT EXISTS author_ttseller boolean;

-- The author's bio as the search result reported it, before any profile scrape.
ALTER TABLE discovery_candidates
  ADD COLUMN IF NOT EXISTS author_signature text;

ALTER TABLE discovery_candidates
  ADD COLUMN IF NOT EXISTS author_verified boolean;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'discovery_candidates_follower_source_check'
  ) THEN
    ALTER TABLE discovery_candidates
      ADD CONSTRAINT discovery_candidates_follower_source_check
      CHECK (follower_count_source IS NULL
             OR follower_count_source IN ('search_item', 'profile_scrape'));
  END IF;
END $$;

COMMIT;
