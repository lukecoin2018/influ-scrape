-- Snapshot the creator's follower count on each partnership edge.
--
-- This is what makes a casting profile stable. Classifying a brand's partners
-- from the creator's CURRENT follower count drifts constantly: 117 of 330
-- partnered creators sit within 2x of a 30k-500k boundary, so a large minority
-- get reclassified every time enrichment refreshes a count. It also answers
-- the wrong question — a creator who was 80k when Zara cast them and is 600k
-- now is evidence that Zara casts in-band.
--
-- With the count snapshotted on the edge, the casting profile becomes a pure
-- function of the edges: it cannot drift, needs no periodic recompute, and can
-- be maintained incrementally as edges are added.
--
-- follower_count_source distinguishes the two populations:
--   'snapshot'   — captured at edge-write time. Accurate.
--   'backfilled' — filled from the creator's current count, after the fact.
--                  Usable for ranking, never to be mistaken for accurate.
--
-- Backfilling rather than leaving NULL is deliberate: every brand scraped
-- before this migration would otherwise look unclassifiable, discarding real
-- signal. An approximate 83% for Chanel is worth more than no number at all.

alter table partnerships
  add column if not exists creator_follower_count integer,
  add column if not exists follower_count_source varchar not null default 'snapshot';

comment on column partnerships.creator_follower_count is
  'The creator''s Instagram follower count at the time this edge was recorded. Basis for the brand casting profile. See follower_count_source for how it was obtained.';

comment on column partnerships.follower_count_source is
  '''snapshot'' = captured at edge-write time and accurate for that moment. ''backfilled'' = derived from the creator''s current count after the fact, for edges predating the snapshot column; directionally useful but not accurate as of the collaboration.';

-- Backfill existing edges from current counts, and mark them as such.
-- The subquery is deterministic: a creator with more than one Instagram
-- profile resolves to the largest, rather than an arbitrary row.
update partnerships p
set creator_follower_count = (
      select sp.follower_count
      from social_profiles sp
      where sp.creator_id = p.creator_id
        and sp.platform = 'instagram'
      order by sp.follower_count desc nulls last
      limit 1
    ),
    follower_count_source = 'backfilled'
where p.creator_follower_count is null;

create index if not exists partnerships_brand_posted_at_idx
  on partnerships (brand_id, posted_at desc);
