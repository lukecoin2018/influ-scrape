-- ============================================================================
-- discovery_candidates gains the search item's point-of-interest
--
-- No placeholders. Safe to paste whole. Touches no existing row.
--
-- xmolodtsov/tiktok-search-scraper returns a `poi` object on search items:
--
--     {"poiName":"Miami","address":"Miami, FL, United States",
--      "cityCode":"4164138","cityName":null,"latitude":null,
--      "longitude":null,"regionCode":null}
--
-- Measured on a real 54-item run for "miami swim": present on 13 items, 24%.
-- That is BETTER coverage than the field it replaces — clockworks'
-- authorMeta.signature resolved a location for only 18% of candidate bios
-- (measured over 528 stored bios), and did so by regex over free text rather
-- than from a structured field.
--
-- RECORDED, NOT FILTERED ON.
--
-- Nothing reads these columns. They exist so a first real run can show what
-- the field actually contains before anything depends on it — the same order
-- the author signals followed: record for a run, read the numbers, then decide
-- what to filter. Filtering on an unexamined field is how a silent
-- misattribution gets shipped.
--
-- WHAT THIS IS AND IS NOT
--
-- poi is a GEOTAG: where the video was made. It is not where the creator
-- lives. A tourist filming in Miami produces a Miami-tagged post and is not a
-- Miami creator. See docs/location-search-investigation.md — the distinction
-- decides which mechanism answers "a creator in Miami", and this is the weaker
-- one. It is stored because it is free, structured and better-covered than the
-- alternative, not because it settles the question.
--
-- Three columns rather than one JSONB: the three fields that carry a value on
-- real data are poiName, address and cityCode (cityName, latitude, longitude
-- and regionCode were null on every item of the measured run). Flat columns
-- keep them greppable and indexable without a JSON path.
-- ============================================================================

BEGIN;

ALTER TABLE discovery_candidates
  ADD COLUMN IF NOT EXISTS poi_name text;

ALTER TABLE discovery_candidates
  ADD COLUMN IF NOT EXISTS poi_address text;

ALTER TABLE discovery_candidates
  ADD COLUMN IF NOT EXISTS poi_city_code text;

COMMENT ON COLUMN discovery_candidates.poi_name IS
  'poi.poiName from the search item, verbatim, e.g. "Miami". A GEOTAG — where the video was made, not where the creator is based. NULL when the item carried no poi (76% of a measured run) and for every source that does not emit one (clockworks hashtag search, Instagram).';

COMMENT ON COLUMN discovery_candidates.poi_address IS
  'poi.address from the search item, e.g. "Miami, FL, United States". Fuller than poi_name and usually carries the country.';

COMMENT ON COLUMN discovery_candidates.poi_city_code IS
  'poi.cityCode from the search item, e.g. "4164138". An opaque TikTok identifier — stable for joining rows about the same place, not resolvable to a name without TikTok.';

-- Partial index: the interesting query is "candidates that carried a place",
-- roughly a quarter of rows from the one source that emits it.
CREATE INDEX IF NOT EXISTS discovery_candidates_poi_name_idx
  ON discovery_candidates (poi_name)
  WHERE poi_name IS NOT NULL;

COMMIT;
