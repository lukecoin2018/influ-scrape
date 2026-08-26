-- Brand-feed scraping: dedicated staleness timestamp.
--
-- brands.last_updated_at cannot be reused as the feed-staleness marker: the
-- creator enrichment pipeline writes it every time a creator's post mentions
-- a brand (app/api/enrich/process/route.ts saveBrandsToTable), so it tracks
-- "when did we last hear about this brand from a creator", not "when did we
-- last read this brand's own feed". All 11,856 rows are non-null today.
--
-- feed_scraped_at is written ONLY by app/api/brand-feed/process.

alter table brands
  add column if not exists feed_scraped_at timestamptz;

comment on column brands.feed_scraped_at is
  'Last time this brand''s own Instagram feed was scraped for creator collaborations. NULL = never scraped. Written only by the brand-feed pipeline; independent of last_updated_at, which the creator enrichment pipeline owns.';

-- NULLS FIRST matches the queue ordering: "never scraped" sorts ahead of
-- "scraped longest ago" with no special-casing in the query.
create index if not exists brands_feed_scraped_at_idx
  on brands (feed_scraped_at nulls first);
