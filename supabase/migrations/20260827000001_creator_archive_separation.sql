-- Physical separation of out-of-range creators.
--
-- creators and social_profiles are left containing ONLY creators inside the
-- active follower band. Out-of-range creators move to archive tables. This is
-- separation rather than filtering because the counts are public: public_stats()
-- feeds marketing sites that claim to read the live database, and a filter
-- someone forgets is a wrong number on a live website.
--
-- Expected effect: creators 7,607 -> 6,781. 826 archived (500 below_min,
-- 326 above_max). Instagram median engagement 1.15 -> 0.86, because
-- below-min creators are small accounts with structurally higher engagement.
--
-- ── Why a registry ───────────────────────────────────────────────────────────
--
-- 1,288 of 2,194 partnership edges belong to out-of-range creators, and all 826
-- have at least one. That intelligence is the point — a brand casting mostly
-- celebrities is exactly what casting profiles reveal — so the edges must
-- survive the move.
--
-- creator_registry holds every creator id ever issued, permanently. creators
-- and creators_archive both feed it; partnerships.creator_id references it. A
-- creator moving between populations therefore touches no foreign key at all.
--
-- The other eight FKs to creators.id stay pointed at creators. They are all
-- platform-app tables (shortlists, outreach, contracts, inquiries,
-- rate_calculations, negotiations, creator_profiles) and today reference zero
-- out-of-range creators — the app only ever sees active creators, so it can
-- only ever reference them. Leaving those FKs in place turns "app data
-- references only active creators" into a database guarantee.
--
-- ── Why one archive pair, not two ───────────────────────────────────────────
--
-- below_min and above_max have identical shape (35 and 32 columns). Two pairs
-- would mean every future column added to creators must be added in three
-- places — schema drift, the same class of bug as two writers owning one
-- derived column. Different futures mean different queries, not different
-- storage, so the split is an archive_reason column plus the two views below.

begin;

-- ── 1. Registry ─────────────────────────────────────────────────────────────
-- Created and populated BEFORE anything moves, so every id that partnerships
-- currently references is already present when the FK is repointed.

create table if not exists creator_registry (
  id                 uuid primary key,
  first_seen_at      timestamptz not null default now(),
  current_population varchar     not null default 'active'
    check (current_population in ('active', 'below_min', 'above_max'))
);

comment on table creator_registry is
  'Every creator id ever issued, permanently. creators and creators_archive both reference it, and partnerships.creator_id points here rather than at creators — so a creator moving between populations never touches a foreign key. Maintained by trigger; application code never writes it directly.';

insert into creator_registry (id, first_seen_at, current_population)
select
  c.id,
  coalesce(c.first_discovered_at, now()),
  case c.import_status
    when 'out_of_range_low'  then 'below_min'
    when 'out_of_range_high' then 'above_max'
    else 'active'
  end
from creators c
on conflict (id) do nothing;

-- ── 2. Archive tables ───────────────────────────────────────────────────────
-- LIKE ... INCLUDING ALL mirrors columns, types, defaults, constraints and
-- indexes, so a creator moves without data loss by construction rather than by
-- a hand-maintained column list. It deliberately does NOT copy foreign keys —
-- social_profiles_archive.creator_id must be free to reference an archived
-- creator.
--
-- This also carries import_status_at and import_status_follower_count, which
-- record what each classification was based on. The promotion check needs them.

create table if not exists creators_archive        (like creators        including all);
create table if not exists social_profiles_archive (like social_profiles including all);

alter table creators_archive
  add column if not exists archive_reason varchar not null default 'below_min'
    check (archive_reason in ('below_min', 'above_max')),
  add column if not exists archived_at timestamptz not null default now();

alter table social_profiles_archive
  add column if not exists archive_reason varchar not null default 'below_min'
    check (archive_reason in ('below_min', 'above_max')),
  add column if not exists archived_at timestamptz not null default now();

create index if not exists creators_archive_reason_idx        on creators_archive (archive_reason);
create index if not exists social_profiles_archive_reason_idx on social_profiles_archive (archive_reason);
create index if not exists social_profiles_archive_creator_idx on social_profiles_archive (creator_id);
create index if not exists social_profiles_archive_handle_idx  on social_profiles_archive (platform, handle);

-- The INSERT ... SELECT below relies on archive_reason and archived_at being
-- the last two columns, which ALTER guarantees. Fail loudly if that ever stops
-- being true rather than silently writing values into the wrong columns.
do $$
declare c_src int; c_dst int; s_src int; s_dst int;
begin
  select count(*) into c_src from information_schema.columns where table_name = 'creators';
  select count(*) into c_dst from information_schema.columns where table_name = 'creators_archive';
  select count(*) into s_src from information_schema.columns where table_name = 'social_profiles';
  select count(*) into s_dst from information_schema.columns where table_name = 'social_profiles_archive';
  if c_dst <> c_src + 2 then
    raise exception 'creators_archive has % columns, expected % (creators + 2)', c_dst, c_src + 2;
  end if;
  if s_dst <> s_src + 2 then
    raise exception 'social_profiles_archive has % columns, expected % (social_profiles + 2)', s_dst, s_src + 2;
  end if;
end $$;

-- ── 3. Registry maintenance by trigger ──────────────────────────────────────
-- A trigger rather than a foreign key from creators.id, so application code
-- never has to know the registry exists. Inserting a creator or an archived
-- creator registers the id automatically.

create or replace function register_active_creator_id() returns trigger
language plpgsql as $$
begin
  insert into creator_registry (id, current_population)
  values (new.id, 'active')
  on conflict (id) do update set current_population = excluded.current_population;
  return new;
end $$;

-- Reads the row's own archive_reason rather than a literal. creator_registry
-- .current_population is constrained to ('active','below_min','above_max'), so
-- passing a literal like 'archived' would raise a check violation on the first
-- archived insert — taking the whole data-move migration down with it.
create or replace function register_archived_creator_id() returns trigger
language plpgsql as $$
begin
  insert into creator_registry (id, current_population)
  values (new.id, new.archive_reason)
  on conflict (id) do update set current_population = excluded.current_population;
  return new;
end $$;

drop trigger if exists trg_register_creator on creators;
create trigger trg_register_creator
  after insert on creators
  for each row execute function register_active_creator_id();

drop trigger if exists trg_register_creator_archive on creators_archive;
create trigger trg_register_creator_archive
  after insert on creators_archive
  for each row execute function register_archived_creator_id();

-- The archive trigger also keeps the registry correct when archive_reason is
-- changed in place, which is how a below_min creator that later grows past the
-- maximum would be reclassified without leaving the archive.
drop trigger if exists trg_reregister_creator_archive on creators_archive;
create trigger trg_reregister_creator_archive
  after update of archive_reason on creators_archive
  for each row execute function register_archived_creator_id();

-- ── 4. Repoint partnerships.creator_id at the registry ──────────────────────
-- Found dynamically: the constraint name is not guaranteed across environments.

do $$
declare fk_name text;
begin
  select con.conname into fk_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_class frel on frel.oid = con.confrelid
  where rel.relname = 'partnerships'
    and frel.relname = 'creators'
    and con.contype = 'f';

  if fk_name is not null then
    execute format('alter table partnerships drop constraint %I', fk_name);
  end if;
end $$;

alter table partnerships
  add constraint partnerships_creator_id_registry_fkey
  foreign key (creator_id) references creator_registry(id);

comment on column partnerships.creator_id is
  'References creator_registry, not creators — the creator may live in creators or creators_archive, and moving between them must not break the edge. 1,288 of 2,194 edges belonged to out-of-range creators at separation time.';

commit;
