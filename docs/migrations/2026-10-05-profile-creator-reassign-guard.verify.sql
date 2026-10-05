-- Verification for 2026-10-05-profile-creator-reassign-guard.sql
-- Read-only. Run after applying. Nothing here writes.
--
-- NOTE: the Supabase SQL editor shows only the LAST statement's result. Run
-- each statement on its own, or use the single-row version at the bottom.

-- 1. The function exists. Expect one row: proname
--    'prevent_profile_creator_reassignment', language 'plpgsql', returns
--    'trigger'.
SELECT p.proname, l.lanname AS language, pg_get_function_result(p.oid) AS returns
FROM pg_proc p
JOIN pg_language l ON l.oid = p.prolang
WHERE p.proname = 'prevent_profile_creator_reassignment';

-- 2. Both triggers exist, fire BEFORE UPDATE OF creator_id, and are enabled.
--    Expect two rows, social_profiles and social_profiles_archive, each with
--    tgenabled 'O' (enabled) and a definition reading
--    "BEFORE UPDATE OF creator_id ... FOR EACH ROW EXECUTE FUNCTION
--    prevent_profile_creator_reassignment()".
SELECT tgrelid::regclass AS table_name, tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgname = 'trg_prevent_profile_creator_reassignment'
ORDER BY 1;

-- 3. The referential actions on each table's creator_id foreign key — the
--    ones that would run as an UPDATE and fire the trigger. Expect one row,
--    for social_profiles -> creators, and none for social_profiles_archive
--    (it has no foreign key by design). on_delete SET NULL or CASCADE and
--    on_update NO ACTION are all compatible with the trigger; see the header
--    of the migration.
SELECT c.conrelid::regclass AS table_name,
       c.conname,
       c.confrelid::regclass AS references_table,
       CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                          WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_update,
       CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                          WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
FROM pg_constraint c
WHERE c.contype = 'f'
  AND c.conrelid IN ('social_profiles'::regclass, 'social_profiles_archive'::regclass)
  AND EXISTS (
    SELECT 1 FROM pg_attribute a
    WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) AND a.attname = 'creator_id'
  );

-- Single-row version of 1 and 2. Expect function_count 1, enabled_triggers 2.
SELECT
  (SELECT count(*) FROM pg_proc WHERE proname = 'prevent_profile_creator_reassignment') AS function_count,
  (SELECT count(*) FROM pg_trigger
     WHERE tgname = 'trg_prevent_profile_creator_reassignment' AND tgenabled = 'O') AS enabled_triggers;
