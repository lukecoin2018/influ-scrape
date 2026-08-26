-- How many posts the last brand-feed scrape returned for each brand.
--
-- Written on every scrape alongside feed_scraped_at. It exists to identify
-- dormant, renamed or placeholder handles: in a 25-brand run, six returned
-- exactly 1 post and 0 candidates (armani, nars, shein_official, ulta,
-- hourglass, medicube) while their live counterparts (narsissist,
-- sheinbrasil, shein_spain) returned a full 12 — roughly 24% of the batch
-- paying for a scrape that cannot yield anything.
--
-- Deliberately NOT used to exclude anything automatically. A brand can have a
-- quiet period, and one low reading is not proof of a dead handle. The queue
-- exposes an optional threshold the operator opts into; the rule itself waits
-- on data across a few hundred brands.
--
-- 0 and NULL are different: 0 means a scrape returned nothing, NULL means this
-- brand has not been scraped since the column existed.

alter table brands
  add column if not exists feed_post_count integer;

comment on column brands.feed_post_count is
  'Posts returned by the most recent brand-feed scrape. NULL = never scraped since this column existed; 0 = scraped and returned nothing. A persistently low count suggests a dormant, renamed or placeholder handle. Advisory only — nothing filters on it automatically.';

-- Supports the optional "skip low-yield brands" queue filter.
create index if not exists brands_feed_post_count_idx
  on brands (feed_post_count)
  where feed_post_count is not null;
