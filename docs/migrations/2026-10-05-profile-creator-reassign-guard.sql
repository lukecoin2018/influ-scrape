-- ============================================================================
-- A social profile never moves from one creator to another
--
-- STATUS: NOT YET APPLIED. Apply by hand in the Supabase SQL editor, one
-- statement at a time, then run 2026-10-05-profile-creator-reassign-guard
-- .verify.sql and update this line with the date.
--
-- WHAT
--
-- One trigger function, attached BEFORE UPDATE OF creator_id on both
-- social_profiles and social_profiles_archive. It raises when a row's
-- creator_id would change from one creator to a DIFFERENT creator:
--
--   OLD.creator_id IS NOT NULL
--   AND NEW.creator_id IS NOT NULL
--   AND NEW.creator_id <> OLD.creator_id
--
-- Everything else passes: an unchanged creator_id (upsert_social_profile
-- always sets it, to COALESCE(p_creator_id, existing)), a NULL creator_id
-- being filled in, and creator_id being set to NULL.
--
-- WHY
--
-- lib/creatorImport.ts read a FAILED existing-profile lookup as "not found",
-- inserted a fresh creator, and passed its id to upsert_social_profile. That
-- function matches on (platform, handle) and sets creator_id =
-- COALESCE(p_creator_id, existing.creator_id), so the existing profile moved
-- to the new creator and the old one was left without it. influence-ai is
-- about to hide brand accounts with creators.status = 'non_creator'; this path
-- would silently bring one back as a fresh active creator.
--
-- The code is fixed in the same branch (lib/creatorImportCore.ts: a lookup
-- error now fails the item). This trigger is the database half, so the same
-- move is refused whichever code path tries it.
--
-- WHY A TRIGGER, NOT AN EDIT TO upsert_social_profile
--
--   - The archive branch of the importer writes social_profiles_archive with
--     a direct PostgREST upsert (onConflict platform,handle), not through the
--     function. A guard inside the function would not cover it.
--   - upsert_social_profile's body is in no repo; retyping it to add a check
--     risks changing something else by transcription.
--   - promote_creator() moves profiles between the two tables by INSERT and
--     DELETE, never by UPDATE, so it is unaffected.
--
-- A deliberate reassignment by hand now needs the trigger disabled for that
-- statement:
--   ALTER TABLE social_profiles DISABLE TRIGGER trg_prevent_profile_creator_reassignment;
--   ... the UPDATE ...
--   ALTER TABLE social_profiles ENABLE TRIGGER trg_prevent_profile_creator_reassignment;
-- No code path in either repo moves a profile on purpose (checked 2026-10-05:
-- upsert_social_profile's only caller is lib/creatorImport.ts, and nothing
-- updates social_profiles.creator_id).
--
-- REFERENTIAL ACTIONS
--
-- A foreign key's ON UPDATE / ON DELETE action runs as an UPDATE on the
-- referencing row and fires this trigger:
--
--   - social_profiles.creator_id references creators(id). Its actions are not
--     in any repo; the .verify.sql reads them. ON DELETE SET NULL sets
--     NEW.creator_id to NULL and passes. ON DELETE CASCADE deletes the row,
--     which is not an UPDATE. ON UPDATE CASCADE would only act if a creators
--     id changed, which nothing does — and if it ever did, this trigger would
--     refuse it, which is the right default.
--   - social_profiles_archive.creator_id has no foreign key, by design
--     (20260827000001_creator_archive_separation.sql:68-73: LIKE ... INCLUDING
--     ALL does not copy foreign keys), so no referential action reaches it.
--
-- The error names the table, platform, handle and both creator ids, so an
-- import log shows exactly what was refused.
-- ============================================================================

create or replace function prevent_profile_creator_reassignment() returns trigger
language plpgsql as $$
begin
  if old.creator_id is not null
     and new.creator_id is not null
     and new.creator_id <> old.creator_id then
    raise exception 'refusing to move profile %:% in % from creator % to creator %',
      new.platform, new.handle, tg_table_name, old.creator_id, new.creator_id
      using hint = 'A social profile never changes creator. If this move is deliberate, disable trg_prevent_profile_creator_reassignment on ' || tg_table_name || ' for that one statement.';
  end if;
  return new;
end $$;

drop trigger if exists trg_prevent_profile_creator_reassignment on social_profiles;

create trigger trg_prevent_profile_creator_reassignment
  before update of creator_id on social_profiles
  for each row execute function prevent_profile_creator_reassignment();

drop trigger if exists trg_prevent_profile_creator_reassignment on social_profiles_archive;

create trigger trg_prevent_profile_creator_reassignment
  before update of creator_id on social_profiles_archive
  for each row execute function prevent_profile_creator_reassignment();

comment on function prevent_profile_creator_reassignment() is
  'Refuses to change social_profiles / social_profiles_archive creator_id from one non-null creator to a different non-null creator. Setting it to or from NULL passes. See docs/migrations/2026-10-05-profile-creator-reassign-guard.sql.';
