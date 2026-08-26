-- Stamp provenance: what the out-of-range decision was based on, and when.
--
-- A future promotion check needs to answer two questions about a stamped
-- profile: how old is the follower count we judged it on, and has it moved?
--
--   import_status_at              when the stamp was applied
--   import_status_follower_count  the follower_count at that moment
--
-- The snapshot is not redundant with social_profiles.follower_count. Stamped
-- profiles are excluded from enrichment, so their live follower_count is
-- frozen at today's value — but the moment a promotion check re-scrapes them
-- it overwrites that column, and without the snapshot there would be no
-- "before" to compare against. Keeping both is what makes growth measurable.
--
-- Profile-level only. The creators roll-up stays a pure status derivation;
-- follower counts are per-platform and a creator-level snapshot would have no
-- well-defined meaning across profiles.

alter table social_profiles
  add column if not exists import_status_at timestamptz,
  add column if not exists import_status_follower_count integer;

comment on column social_profiles.import_status_at is
  'When import_status was last set to a non-active value. NULL while active. Drives re-check prioritisation: the stalest stamps are judged on the oldest follower counts and should be re-scraped first.';

comment on column social_profiles.import_status_follower_count is
  'follower_count at the moment import_status was stamped. NULL while active. Compared against a fresh scrape to decide whether an out_of_range_low profile has grown into range and can be promoted.';

-- Backfill rows stamped before these columns existed. COALESCE keeps this
-- idempotent and prevents a re-run from resetting a genuine stamp time.
update social_profiles
set import_status_at = coalesce(import_status_at, now()),
    import_status_follower_count = coalesce(import_status_follower_count, follower_count)
where import_status <> 'active';

-- Oldest-stamp-first is the access pattern for the promotion queue. Partial,
-- because active rows are never in it.
create index if not exists social_profiles_import_status_at_idx
  on social_profiles (import_status_at)
  where import_status <> 'active';
