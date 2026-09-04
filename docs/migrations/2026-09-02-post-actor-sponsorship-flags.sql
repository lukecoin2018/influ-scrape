-- ============================================================================
-- creator_posts gains the actor's own sponsorship flags
--
-- No placeholders. Safe to paste whole. Touches no existing row.
--
-- clockworks/tiktok-profile-scraper — the actor the enrichment path already
-- uses — returns isSponsored and isAd on every post item. Neither has ever been
-- read. Measured on 886 post items from 60 past runs:
--
--     actor isSponsored = true    116   13.1%
--     actor isAd        = true    100   11.3%
--     detector said sponsored      20    2.3%
--
-- The detector agrees on 13 of the 116. It misses 103 — 89%. For comparison the
-- detector finds 11.9% of INSTAGRAM posts sponsored, so TikTok is not a less
-- sponsored platform; its sponsorship is less legible to a text-only detector.
--
-- STORED SEPARATELY, DELIBERATELY, FOR A LOAD-BEARING REASON
--
-- These do NOT overwrite is_sponsored, and must not. lib/brandAggregation.ts
-- recalculateCumulativeBrandFields() re-runs detectBrandsInPost over stored
-- posts and, with persistPostUpdates, writes is_sponsored back whenever the
-- detector disagrees with what is stored. Folding the actor's verdict into
-- is_sponsored would therefore be silently reverted on the next enrich or
-- reprocess-brands pass, and the disagreement — the thing worth measuring —
-- would be destroyed rather than recorded.
--
-- Two independent verdicts in two columns keeps them comparable on every post.
--
-- NULL MEANS NOT OBSERVED, NOT FALSE
--
-- Nullable on purpose, and three-valued:
--
--     true   the actor reported the flag set
--     false  the actor reported the flag clear
--     NULL   no value came back — every Instagram post, and every row written
--            before this migration
--
-- Collapsing NULL into false would make "we never looked" indistinguishable
-- from "we looked and it was not sponsored", which is precisely the comparison
-- this exists to support.
--
-- The field's provenance is UNVERIFIED. The actor documents neither flag, so
-- whether isSponsored reflects TikTok's own paid-partnership disclosure or the
-- actor's heuristic is not known. That is what the hand-labelling exercise is
-- for. Recording it separately is what makes the answer measurable either way.
-- ============================================================================

BEGIN;

ALTER TABLE creator_posts
  ADD COLUMN IF NOT EXISTS actor_is_sponsored boolean;

ALTER TABLE creator_posts
  ADD COLUMN IF NOT EXISTS actor_is_ad boolean;

COMMENT ON COLUMN creator_posts.actor_is_sponsored IS
  'The scraping actor''s own sponsorship verdict for this post, stored verbatim. NOT the pipeline''s: is_sponsored holds detectBrandsInPost''s verdict and is overwritten by lib/brandAggregation.ts on re-detection, so the two must stay in separate columns to remain comparable. NULL = the actor returned no value (all Instagram posts; all rows written before 2026-09-02). Provenance undocumented by the actor as of 2026-09-02.';

COMMENT ON COLUMN creator_posts.actor_is_ad IS
  'The scraping actor''s isAd flag, stored verbatim. Distinct from actor_is_sponsored: across 886 measured items 81 carried both, 35 were sponsored-only and 19 ad-only, which is consistent with isAd meaning paid promotion and isSponsored meaning branded-content disclosure. NULL = not observed.';

-- Partial index: the interesting query is "posts the actor flagged", which is
-- ~13% of TikTok rows. Indexing only the true rows keeps it small.
CREATE INDEX IF NOT EXISTS creator_posts_actor_is_sponsored_true_idx
  ON creator_posts (social_profile_id)
  WHERE actor_is_sponsored IS TRUE;

COMMIT;
