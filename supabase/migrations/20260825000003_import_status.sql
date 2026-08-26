-- Import status: keep out-of-range profiles in the database but out of the
-- spend pipelines (enrichment, intelligence, AI summaries, embeddings).
--
-- Two columns rather than one, and NOT a reuse of creators.status:
--
--   social_profiles.import_status is the source of truth. follower_count lives
--   on this table and the range decision is per-platform, so this is where the
--   decision is actually made.
--
--   creators.import_status is a roll-up. The embeddings pipeline queries
--   `creators` in five of its six modes and cannot filter on a social_profiles
--   column; without the roll-up every one of those modes would need a paged
--   JS join. A creator is 'out_of_range' only when ALL of their profiles are —
--   someone in range on TikTok but not Instagram still gets embedded.
--
-- creators.status is deliberately left alone: it is already consumed by
-- get-creators?status= and possibly by the platform app.
--
-- Existing rows all become 'active' via the column default. There is no
-- backfill of the ~229 profiles currently outside 30k-500k; they are already
-- enriched and stay maintained until that is decided separately.

alter table social_profiles
  add column if not exists import_status varchar not null default 'active';

comment on column social_profiles.import_status is
  '''active'' = eligible for the enrichment/intelligence/embedding pipelines. ''out_of_range'' = follower_count fell outside the configured import range at discovery time; kept for partnership history but excluded from all spend pipelines. Source of truth for creators.import_status.';

alter table creators
  add column if not exists import_status varchar not null default 'active';

comment on column creators.import_status is
  'Roll-up of social_profiles.import_status: ''out_of_range'' only when every one of this creator''s profiles is out of range. Exists so the creators-based embedding queries can filter in one predicate.';

-- Every pipeline query filters on these, so both get an index. Partial on the
-- common value keeps them small: the overwhelming majority of rows are active.
create index if not exists social_profiles_import_status_idx
  on social_profiles (import_status)
  where import_status <> 'active';

create index if not exists creators_import_status_idx
  on creators (import_status)
  where import_status <> 'active';
