-- Partnerships: discovery provenance + real dedupe.
--
-- Context: the partnerships table is empty (0 rows) at the time of this
-- migration, so both changes are zero-risk — no backfill, no lock contention.

-- 1. Provenance ---------------------------------------------------------------
--
-- discovered_via_hashtag is a nullable varchar and would physically accept
-- 'brand_feed', but that conflates "which hashtag surfaced this post" with
-- "which pipeline found this edge", and gives up recording the hashtag on
-- hashtag-discovered rows. A separate column keeps both facts.
--
-- Default 'hashtag' so the existing writer (app/api/database/save-partnerships)
-- stays correct without being changed.

alter table partnerships
  add column if not exists discovery_source varchar not null default 'hashtag';

comment on column partnerships.discovery_source is
  'Which pipeline discovered this edge: ''hashtag'' (sponsorship discovery over hashtag posts) or ''brand_feed'' (scraping a brand''s own feed for tagged/coauthored creators).';

create index if not exists partnerships_discovery_source_idx
  on partnerships (discovery_source);

-- 2. Dedupe -------------------------------------------------------------------
--
-- There is no uniqueness today. app/api/database/save-partnerships claims
-- "ON CONFLICT DO NOTHING" in a comment but issues a plain .insert(), which
-- supabase-js never translates to an ON CONFLICT clause — so re-running
-- discovery over the same posts would duplicate every edge.
--
-- NOTE: this is a PLAIN unique index, not a partial one.
--
-- A partial index (`... where post_url is not null`) would express the intent
-- more precisely, but Postgres cannot infer a partial index as an ON CONFLICT
-- arbiter unless the statement repeats the index predicate
-- (`on conflict (cols) where post_url is not null`). PostgREST's on_conflict
-- parameter only accepts column names and cannot emit that clause, so every
-- upsert against a partial index fails with 42P10 "no unique or exclusion
-- constraint matching the ON CONFLICT specification".
--
-- Consequence of going plain: rows with a NULL post_url are still mutually
-- distinct (standard NULL semantics) and are not deduped by this index. That
-- is acceptable — a row with no post_url has no identity to dedupe on. The
-- brand-feed writer skips posts that carry no URL, so it never emits one.

create unique index if not exists partnerships_unique_creator_brand_post
  on partnerships (creator_id, brand_id, post_url);
