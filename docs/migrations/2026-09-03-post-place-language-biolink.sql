-- ============================================================================
-- Post-history signals: place, language, and the bio link
--
-- No placeholders. Safe to paste whole. Touches no existing row.
--
-- REPLACES the earlier 2026-09-03-post-place.sql, which was never applied.
-- Three fields the enrichment actor already returns and nothing has ever read.
--
-- clockworks/tiktok-profile-scraper, measured across completed runs:
--
--     locationMeta          8% of posts    but 15% of CREATORS have >=2
--     textLanguage         99% of posts
--     authorMeta.bioLink   86% of posts / 83% of creators
--
-- ── 1. PLACE: why a distribution and not a tag ─────────────────────────────
--
-- Per post 8% looks useless. Per creator it is not, because people geotag
-- habitually or not at all:
--
--     creators with >=1 tagged post   6 of 27   22%
--     creators with >=2 tagged posts  4 of 27   15%
--     and all 4 of those had >=60% of their tags on ONE cityCode
--
--     @katnimpa       15/15 tagged, all Bangkok
--     @fleurdumalnyc  15/15 tagged, 13 New York + 2 Los Angeles
--     @mya_babycurls   5/15 tagged,  4 Orlando
--
-- A DISTRIBUTION is what separates living somewhere from passing through —
-- the distinction every other location mechanism examined has failed. One
-- geotagged post is a visit and is deliberately not written.
--
-- Expected yield: ~500 of 3,528 TikTok profiles as they re-enrich.
--
-- cityCode is the key, locationName is not: one New York code carried both
-- "Fleur du Mal NYC Nolita Boutique" and "Fleur Du Mal"; search-side data had
-- five names collapsing to two codes for Miami, a "Miami" at an Italian
-- address, and a "For You" in Moscow.
--
-- THE CODES ARE GEONAMES IDs — verified against the dumps, not assumed:
--   countryCode  5/5 exact: 6252001 US, 2635167 GB, 1605651 TH, 357994 EG,
--                390903 GR
--   cityCode     8/9, at INCONSISTENT granularity: 5128581 New York City and
--                4167147 Orlando are cities; 1609348 "Bangkok" is an admin1
--                province; 6697808 is the South Aegean region, not Naxos;
--                2647599 is a village of 2,218; 4156326 is Frostproof FL while
--                TikTok labelled it "Florida"; and 52200211 is not in GeoNames
--                at all, its id being far outside the range.
--
-- Hence the split: countryCode is the market-facing field because it resolved
-- cleanly every time; cityCode carries identity for the dominance calculation
-- only. A city-level filter built on these codes would have failed silently.
--
-- ── 2. LANGUAGE: better than the heuristic it does not replace ─────────────
--
-- Compared against detectLanguage() on the same 35 creators: 31 agree, 3
-- disagree, 1 where the heuristic was blank. All four non-agreements favour
-- the actor — it called Swedish where the heuristic said Portuguese, English
-- where it said German on a 12-to-3 split, and Romanian where it said French
-- on a creator with no French posts at all.
--
-- 'un' (15.6% of posts) is excluded before the vote rather than counted and
-- ignored: one creator is un:13 de:2, and a naive count returns 'un' for them.
--
-- ── 3. BIO LINK: stored, and NOT a monetisation signal ─────────────────────
--
-- Recorded because it is free while the mapper is open. Presence means little:
-- of 29 creators with one, 13 were linktr.ee and 5 instagram.com, against only
-- 4 affiliate platforms (shopltk, shopmy, likeshop, amzn). 45% aggregators.
-- Do not filter on presence. Resolving what the aggregators point at would be
-- a different piece of work.
--
-- ── NULL SEMANTICS, THROUGHOUT ─────────────────────────────────────────────
--
-- NULL means not observed, never "observed as nothing". 92% of posts carry no
-- place; a creator below the place or language thresholds gets NULL rather
-- than a low-confidence guess. Collapsing those would make "we did not look"
-- indistinguishable from "we looked and found none".
-- ============================================================================

BEGIN;

-- ── Per post ───────────────────────────────────────────────────────────────
ALTER TABLE creator_posts ADD COLUMN IF NOT EXISTS place_city_code    text;
ALTER TABLE creator_posts ADD COLUMN IF NOT EXISTS place_country_code text;
ALTER TABLE creator_posts ADD COLUMN IF NOT EXISTS place_name         text;
ALTER TABLE creator_posts ADD COLUMN IF NOT EXISTS place_address      text;
ALTER TABLE creator_posts ADD COLUMN IF NOT EXISTS place_city         text;
ALTER TABLE creator_posts ADD COLUMN IF NOT EXISTS post_language      text;

COMMENT ON COLUMN creator_posts.place_city_code IS
  'locationMeta.cityCode, verbatim. A GeoNames id in 8 of 9 measured cases but at inconsistent granularity — sometimes a city, sometimes an admin1 region, once absent from GeoNames entirely. Stable enough to GROUP BY; not reliably resolvable to a city name. NULL on ~92% of posts, meaning untagged.';
COMMENT ON COLUMN creator_posts.place_country_code IS
  'locationMeta.countryCode, verbatim. A GeoNames id; resolved exactly in 5 of 5 measured cases. The reliable half of the pair and the one a market filter should use.';
COMMENT ON COLUMN creator_posts.place_name IS
  'locationMeta.locationName. Venue-level and noisy — one city code carries several. Decoration, never a join key.';
COMMENT ON COLUMN creator_posts.place_address IS 'locationMeta.address, verbatim.';
COMMENT ON COLUMN creator_posts.place_city IS
  'locationMeta.city. Only ~3% coverage but cleaner than locationName where present.';
COMMENT ON COLUMN creator_posts.post_language IS
  'textLanguage from the actor, lowercased. NULL when absent or ''un'' (undetermined, 15.6% of posts) — ''un'' is never stored, so a NULL here means no determinable language rather than a language called un.';

CREATE INDEX IF NOT EXISTS creator_posts_place_city_code_idx
  ON creator_posts (place_city_code) WHERE place_city_code IS NOT NULL;

-- ── Per creator: derived, beside the bio-inferred columns, never merged ────
--
-- detected_country / detected_language hold bio inference. These hold post
-- history. They are different KINDS of evidence and the two disagreeing is
-- information worth keeping rather than resolving silently — the same
-- reasoning that put actor_is_sponsored beside is_sponsored.
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS place_city_code       text;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS place_country_code    text;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS place_name            text;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS place_confidence      real;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS place_tagged_posts    integer;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS place_total_posts     integer;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS post_language         text;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS post_language_confidence real;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS post_languages        text[];
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS bio_link              text;

COMMENT ON COLUMN social_profiles.place_city_code IS
  'Dominant place across scraped post history. Written only when >=2 posts carried a place AND >=60% fell on this one code — one geotagged post is a visit, not a residence. NULL means the thresholds were not met, NOT that the creator has no location.';
COMMENT ON COLUMN social_profiles.place_country_code IS
  'GeoNames country id of the dominant place, taken from the winning city''s posts rather than voted separately, so a creator split between two cities in one country still resolves to that country.';
COMMENT ON COLUMN social_profiles.place_confidence IS
  'Posts on the winning code / posts carrying any place. 1.0 means every geotagged post was the same place.';
COMMENT ON COLUMN social_profiles.place_tagged_posts IS 'Posts carrying a place — the denominator of place_confidence.';
COMMENT ON COLUMN social_profiles.place_total_posts IS 'Posts inspected, tagged or not. Says how thin the evidence is.';
COMMENT ON COLUMN social_profiles.post_language IS
  'Dominant language across post history, from the actor rather than the stopword heuristic. Written only when >=3 posts carried a determinable language AND >=60% agree. Distinct from detected_language, which is the heuristic''s answer; where they disagree the actor was right in all four measured cases.';
COMMENT ON COLUMN social_profiles.post_language_confidence IS 'Posts in the winning language / posts with any determinable language.';
COMMENT ON COLUMN social_profiles.post_languages IS
  'Every language seen across post history, most frequent first. Exposes bilingual creators that the single dominant answer hides.';
COMMENT ON COLUMN social_profiles.bio_link IS
  'authorMeta.bioLink, verbatim. NOT a monetisation signal: of 29 measured creators with one, 13 were linktr.ee and 5 instagram.com against 4 affiliate platforms. Recorded because it is free; do not filter on presence.';

CREATE INDEX IF NOT EXISTS social_profiles_place_country_code_idx
  ON social_profiles (place_country_code) WHERE place_country_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_profiles_post_language_idx
  ON social_profiles (post_language) WHERE post_language IS NOT NULL;

COMMIT;
