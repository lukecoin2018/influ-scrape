-- ============================================================================
-- Seed expansion: a fourth search source, and the mark that stops it looping
--
-- No placeholders. Safe to paste whole. Touches no existing row's data — the
-- CHECK is widened, not narrowed, and the new column starts NULL everywhere.
--
-- WHAT THIS ENABLES
--
-- Traversing one known creator's FOLLOWING list to find new candidates.
-- clockworks/tiktok-followers-scraper, input {profiles, maxFollowersPerProfile:
-- 0, maxFollowingPerProfile: N}, returns one item per followed account carrying
-- the same authorMeta shape the search actors return — name, fans, signature,
-- verified, ttSeller. So the whole existing funnel applies unchanged: the free
-- follower reading, the entity filter, the known-handle check, the reject
-- cache. Only the scrape step differs.
--
-- WHAT THIS DELIBERATELY DOES NOT ENABLE, AND WHY THE COLUMN IS A DATE
--
-- There is no promotion and no loop. A creator discovered by expansion is
-- never automatically enrolled as the next seed. That was the original design
-- and it was abandoned on measurement, not on taste:
--
--   pairwise overlap between four seeds' outputs   0, 0, 0, 0, 0, 1
--   city concentration (Bogota) among placed       42.3%   vs a 42% base
--   country concentration (Colombia), geotag       64.7% null, n=34
--   country concentration, bio proxy, like-for-like
--     baseline  48.0% Colombian (n=50)
--     expansion 46.2% Colombian (n=39)   z = -0.17, -1.8pp, not significant
--
-- Expansion surfaces on-market creators cheaply. It does NOT concentrate them
-- by place, so there is no gradient for a loop to climb: promoting on a matched
-- country would re-select the distribution it started from. The full reasoning
-- is in docs/seed-expansion-investigation.md — read it before proposing a loop
-- again.
--
-- seed_expanded_at is therefore a ONCE-ONLY mark, not a cursor. It exists so
-- the queue can exclude what has already been traversed, and so a re-run of the
-- same seed is a deliberate act (clearing the column) rather than an accident.
-- ============================================================================

BEGIN;

-- ── 1. Widen discovery_runs.search_source ─────────────────────────────────
--
-- DROP + ADD in one transaction, exactly as 2026-08-29-discovery-search-source
-- said widening would be done. Not IF NOT EXISTS: the constraint is present and
-- must be replaced, and a guard that skipped the replacement would leave a
-- two-value CHECK in place while the application started sending a third value
-- — every seed run would fail its insert with a constraint violation.
ALTER TABLE discovery_runs
  DROP CONSTRAINT IF EXISTS discovery_runs_search_source_check;

ALTER TABLE discovery_runs
  ADD CONSTRAINT discovery_runs_search_source_check
  CHECK (search_source IN ('hashtag', 'keyword', 'seed'));

COMMENT ON COLUMN discovery_runs.search_source IS
  'What the terms in hashtags[] ARE, orthogonal to discovery_mode (what the run is FOR). hashtag: tags. keyword: free text. seed: TikTok handles whose FOLLOWING lists are traversed — the terms are creators we already hold, not queries.';

-- ── 2. The once-only mark on the seed ─────────────────────────────────────
ALTER TABLE social_profiles
  ADD COLUMN IF NOT EXISTS seed_expanded_at timestamptz;

COMMENT ON COLUMN social_profiles.seed_expanded_at IS
  'When this profile''s FOLLOWING list was traversed as a seed expansion source. NULL means never traversed — it is not a "due" date and there is no re-expansion schedule. A seed is expanded once; its following list is near-static and re-traversing it pays again for the same handles, which the known-handle filter would then reject for free. Clearing this column is how a deliberate re-expansion is requested.';

-- Partial index sized to the query the seed queue actually runs: active TikTok
-- profiles not yet expanded, filtered on language and following count. Partial
-- on the NULL because expanded seeds are permanently excluded and there is no
-- reason to index them.
CREATE INDEX IF NOT EXISTS social_profiles_seed_queue_idx
  ON social_profiles (platform, post_language, following_count)
  WHERE seed_expanded_at IS NULL AND import_status = 'active';

COMMIT;
