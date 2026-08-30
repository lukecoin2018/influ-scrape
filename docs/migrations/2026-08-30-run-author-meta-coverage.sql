-- ============================================================================
-- discovery_runs.author_meta_coverage
--
-- No placeholders. Safe to paste whole. Touches no existing row.
-- No DELETE and no UPDATE in this file.
--
-- The first TikTok probe measured exactly what it was built to measure — how
-- much of clockworks' author metadata arrives on a search item — and the figure
-- was computed in the route, returned in the response, and never stored. The
-- panel was not seen, so the run's central result could not be answered from
-- the database afterwards. Only a partial reconstruction was possible, and a
-- separate bug had overwritten half of even that.
--
-- Keyed by search term rather than aggregated, because coverage is a property
-- of what the actor returned for THAT query. One term returning nothing while
-- three return everything is a different finding from all four returning three
-- quarters, and an aggregate cannot tell them apart.
--
-- Shape per term:
--   { "try on haul": { "items": 49, "withFollowerCount": 49, "withSignature": 49,
--                      "withTtSeller": 0, "withVerified": 29,
--                      "followerCountRate": 1.0, "rawItems": 50,
--                      "rawWithAuthorMeta": 50, "rawWithFans": 50,
--                      "rawAds": 0, "rawAdsWithFans": 0, "rawPrivateAuthors": 0 } }
--
-- jsonb rather than columns: the shape has already grown once (the item-level
-- counts were added after the author-level ones), and a signal the actor starts
-- or stops returning should not need a migration to record.
-- ============================================================================

BEGIN;

ALTER TABLE discovery_runs
  ADD COLUMN IF NOT EXISTS author_meta_coverage jsonb;

COMMIT;
