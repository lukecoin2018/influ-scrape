-- Moves the existing out-of-range creators into the archive.
--
-- Separate from the structural migration so it can be reviewed and run on its
-- own, and so a failed move can be retried without re-running DDL.
--
-- Asserts its own expectations. If the counts are not exactly 500 below_min /
-- 326 above_max and creators does not drop 7,607 -> 6,781, it aborts rather
-- than half-completing. Idempotent: re-running after success moves nothing,
-- because the source rows are gone.
--
-- ── Note for a future reader ────────────────────────────────────────────────
--
-- After this runs, the import_status filters in public_stats(), match_creators()
-- and the 23 pipeline queries across enrich / intelligence / embeddings /
-- extract-locations become REDUNDANT — the out-of-range rows are no longer in
-- creators or social_profiles for them to exclude. They are deliberately left
-- in place as defence in depth. They are not load-bearing, and removing them
-- would not change any result; do not treat their presence as evidence that
-- filtering is still how separation works.

begin;

-- ── Before ──────────────────────────────────────────────────────────────────

do $$
declare
  n_creators int; n_low int; n_high int; n_profiles int; n_edges int;
begin
  select count(*) into n_creators from creators;
  select count(*) into n_low      from creators where import_status = 'out_of_range_low';
  select count(*) into n_high     from creators where import_status = 'out_of_range_high';
  select count(*) into n_profiles from social_profiles where import_status <> 'active';
  select count(*) into n_edges    from partnerships;

  raise notice 'BEFORE  creators=%  below_min=%  above_max=%  archived_profiles=%  edges=%',
    n_creators, n_low, n_high, n_profiles, n_edges;

  if n_low <> 500 then
    raise exception 'expected 500 below_min creators, found % — investigate before running', n_low;
  end if;
  if n_high <> 326 then
    raise exception 'expected 326 above_max creators, found % — investigate before running', n_high;
  end if;
  if n_creators <> 7607 then
    raise exception 'expected 7,607 creators, found % — investigate before running', n_creators;
  end if;
end $$;

-- ── Move profiles first ─────────────────────────────────────────────────────
-- Profiles before creators: social_profiles.creator_id still references
-- creators at this point, so the parent must outlive the child.
--
-- Every out-of-range creator has exactly one profile and none has a mix of
-- active and archived profiles, so no creator is split by this.

insert into social_profiles_archive
select
  sp.*,
  case sp.import_status
    when 'out_of_range_low'  then 'below_min'
    when 'out_of_range_high' then 'above_max'
  end,
  now()
from social_profiles sp
where sp.import_status <> 'active'
  and not exists (select 1 from social_profiles_archive a where a.id = sp.id);

delete from social_profiles where import_status <> 'active';

-- ── Then creators ───────────────────────────────────────────────────────────

insert into creators_archive
select
  c.*,
  case c.import_status
    when 'out_of_range_low'  then 'below_min'
    when 'out_of_range_high' then 'above_max'
  end,
  now()
from creators c
where c.import_status <> 'active'
  and not exists (select 1 from creators_archive a where a.id = c.id);

delete from creators where import_status <> 'active';

update creator_registry r
set current_population = a.archive_reason
from creators_archive a
where a.id = r.id;

-- ── After ───────────────────────────────────────────────────────────────────

do $$
declare
  n_creators int; n_arch_low int; n_arch_high int;
  n_profiles int; n_edges int; n_orphan int; n_registry int;
begin
  select count(*) into n_creators  from creators;
  select count(*) into n_arch_low  from creators_archive where archive_reason = 'below_min';
  select count(*) into n_arch_high from creators_archive where archive_reason = 'above_max';
  select count(*) into n_profiles  from social_profiles_archive;
  select count(*) into n_edges     from partnerships;
  select count(*) into n_registry  from creator_registry;

  -- Every edge must still resolve to a registered creator.
  select count(*) into n_orphan
  from partnerships p
  where not exists (select 1 from creator_registry r where r.id = p.creator_id);

  raise notice 'AFTER   creators=%  archived_below=%  archived_above=%  archived_profiles=%  edges=%  registry=%',
    n_creators, n_arch_low, n_arch_high, n_profiles, n_edges, n_registry;

  if n_creators <> 6781 then
    raise exception 'expected creators to drop to 6,781, found % — rolling back', n_creators;
  end if;
  if n_arch_low <> 500 then
    raise exception 'expected 500 archived below_min, found % — rolling back', n_arch_low;
  end if;
  if n_arch_high <> 326 then
    raise exception 'expected 326 archived above_max, found % — rolling back', n_arch_high;
  end if;
  if n_profiles <> 826 then
    raise exception 'expected 826 archived profiles, found % — rolling back', n_profiles;
  end if;
  if n_edges <> 2194 then
    raise exception 'partnership edges changed from 2,194 to % — rolling back', n_edges;
  end if;
  if n_orphan <> 0 then
    raise exception '% partnership edges no longer resolve to a registered creator — rolling back', n_orphan;
  end if;

  raise notice 'OK — 826 creators archived, all % edges intact, 0 orphans', n_edges;
end $$;

commit;
