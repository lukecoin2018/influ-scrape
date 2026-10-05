-- ============================================================================
-- Delete 18 orphaned creators: 11 in creators, 7 in creators_archive
--
-- STATUS: NOT YET APPLIED. OPTIONAL. Apply by hand in the Supabase SQL
-- editor, one statement at a time, in the order below, checking each
-- result against what it says to expect. Then update this line with the date.
--
-- Written to docs/verification-rules.md, "Deletions in migrations": every
-- DELETE is scoped to a literal id list and preceded by a SELECT with the
-- identical WHERE clause, and the referencing tables are read from the schema
-- (step 1), not recalled. That rule exists because of
-- docs/incident-2026-08-29-unscoped-delete.md.
--
-- WHAT THESE ARE
--
-- Creator rows with no profile beneath them. The importer inserted the
-- creator, the profile write then failed, and the loop moved on without
-- removing the creator (lib/creatorImport.ts before fix/import-no-reassign;
-- the importer now deletes such a creator again). They carry nothing but a
-- display name — no handle, so they cannot be re-scraped or claimed.
--
--   creators (11, all TikTok, registered 2026-08-29 to 2026-09-06):
--     kii3kii3, SUPER HOT MODELS (twice: one account tried twice, 9 hours
--     apart), Daniel Lurie, Lux Motors, outfitperfecto07, DKRS, Shake,
--     Mystery Fashionist, Tonal Velasco, Maite Basaguren.
--   creators_archive (7, all Instagram, below_min, archived 2026-08-30 to
--     2026-09-01):
--     Clean Skin Club UK, Thatgirlsholape, Dossier UK, Mohammad Alkandery,
--     Israel Avila, SAVANNAH, Markos Bitsakakis.
--
-- WHY DELETE RATHER THAN A STATUS
--
-- The 11 live ones are visible today: v_creator_summary shows them as rows
-- with neither handle, so they reach unfiltered directory lists and counts.
-- A status ('rejected') would hide them but keep empty rows every reader has
-- to remember to exclude, beside phase 2's 'non_creator'. The 7 archived ones
-- are read by nothing.
--
-- WHAT IT AFFECTS (measured 2026-10-05, service-role reads)
--
--   - creator_entity (influence-ai 0026, ON DELETE CASCADE): one row for each
--     of the 11 live ids, all entity_type 'other'. They are deleted with them.
--   - Nothing else: no row in social_profiles, social_profiles_archive,
--     creator_profiles, shortlist_items, inquiries, creator_outreach,
--     creator_requests, negotiations, contracts, rate_calculations,
--     partnerships, funnel_events, and no brand_reports pin or exclusion.
--   - creator_registry keeps all 18 ids. The registry is "every id ever
--     issued", has no foreign key to creators, and already holds 132 ids of
--     deleted creators from 2026-08-29. No partnership references these 18.
--
-- STOP if step 1 lists a referencing table that step 2 does not check, or if
-- step 2 shows any count other than the expected one. Either means these are
-- no longer the rows this file was written for.
-- ============================================================================


-- ── 1. Every table with a foreign key to creators or creators_archive ──────
-- Expect, for creators: social_profiles, creator_profiles, shortlist_items,
-- inquiries, creator_outreach, creator_requests, negotiations, contracts,
-- rate_calculations, creator_entity (delete_rule CASCADE), and nothing for
-- creators_archive. partnerships points at creator_registry instead.
-- Any table not in step 2 below: STOP and add a check for it.

SELECT ccu.table_name AS referenced_table, tc.table_name, kcu.column_name, rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu   ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name IN ('creators', 'creators_archive')
ORDER BY 1, 2;


-- ── 2. References to the 18 ids, one SELECT per table ──────────────────────
-- One statement, one row per table, so the SQL editor shows all of it.
-- Expect 0 everywhere except creator_entity = 11 (the live ids; they go with
-- the creators by CASCADE). social_profiles and social_profiles_archive MUST
-- be 0: a profile there means the creator is no longer an orphan.

WITH ids(id) AS (VALUES
  ('66c2e483-1405-46b1-b4de-65b929e87a32'::uuid), ('f1f14b08-c624-448e-9456-ed7e13e3b505'::uuid),
  ('e35f2b2d-948b-4ee1-9bd6-a63f4509f070'::uuid), ('175aa895-335a-4daa-86d2-f2c108b4070c'::uuid),
  ('7ec0eef7-ebb8-499a-816f-83607eb24e4e'::uuid), ('3996f501-eba7-4a7e-b81f-92c36b850a09'::uuid),
  ('9776d53d-7be9-46df-a7f0-930bb0d5787b'::uuid), ('8aa47115-2688-4fe3-9934-8aa93b089f93'::uuid),
  ('5618f7d2-a816-4d68-bd7d-8beb96eb2418'::uuid), ('729242b5-7e50-4013-8a55-49ca52f4cfad'::uuid),
  ('41874097-f254-4a64-8d2c-d793992283cc'::uuid),
  ('0d26f4a4-d892-4e1e-84be-f8265bd633a2'::uuid), ('741c20f7-2c39-42a9-8d00-e06a00313cfb'::uuid),
  ('08b00b2f-c510-4563-bd24-906b2a079676'::uuid), ('699a1917-2039-42bb-be2f-c9f61dadb3bb'::uuid),
  ('4fd9a985-b135-465e-89ae-206381ee4d52'::uuid), ('a7f38ad8-edf5-4f98-8df3-596fd9fad316'::uuid),
  ('9d6d4bf7-35b1-4936-a1c7-3b36982509de'::uuid)
)
SELECT 'social_profiles' AS table_name, count(*) FROM social_profiles WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'social_profiles_archive', count(*) FROM social_profiles_archive WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'creator_profiles', count(*) FROM creator_profiles WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'shortlist_items', count(*) FROM shortlist_items WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'inquiries', count(*) FROM inquiries WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'creator_outreach', count(*) FROM creator_outreach WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'creator_requests', count(*) FROM creator_requests WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'negotiations', count(*) FROM negotiations WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'contracts', count(*) FROM contracts WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'rate_calculations', count(*) FROM rate_calculations WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'partnerships', count(*) FROM partnerships WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'creator_entity', count(*) FROM creator_entity WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'funnel_events', count(*) FROM funnel_events WHERE creator_id IN (SELECT id FROM ids)
UNION ALL SELECT 'brand_reports (pinned or excluded)', count(*) FROM brand_reports
  WHERE EXISTS (SELECT 1 FROM ids WHERE ids.id = ANY (pinned_creator_ids) OR ids.id = ANY (excluded_creator_ids));


-- ── 3. The rows the DELETEs will remove (identical WHERE clauses) ──────────
-- Expect 11 rows, all TikTok, all status 'active'.

SELECT id, display_name, primary_platform, status, first_discovered_at FROM creators WHERE id IN (
  '66c2e483-1405-46b1-b4de-65b929e87a32', 'f1f14b08-c624-448e-9456-ed7e13e3b505',
  'e35f2b2d-948b-4ee1-9bd6-a63f4509f070', '175aa895-335a-4daa-86d2-f2c108b4070c',
  '7ec0eef7-ebb8-499a-816f-83607eb24e4e', '3996f501-eba7-4a7e-b81f-92c36b850a09',
  '9776d53d-7be9-46df-a7f0-930bb0d5787b', '8aa47115-2688-4fe3-9934-8aa93b089f93',
  '5618f7d2-a816-4d68-bd7d-8beb96eb2418', '729242b5-7e50-4013-8a55-49ca52f4cfad',
  '41874097-f254-4a64-8d2c-d793992283cc'
);

-- Expect 7 rows, all Instagram, archive_reason 'below_min'.

SELECT id, display_name, primary_platform, archive_reason, archived_at FROM creators_archive WHERE id IN (
  '0d26f4a4-d892-4e1e-84be-f8265bd633a2', '741c20f7-2c39-42a9-8d00-e06a00313cfb',
  '08b00b2f-c510-4563-bd24-906b2a079676', '699a1917-2039-42bb-be2f-c9f61dadb3bb',
  '4fd9a985-b135-465e-89ae-206381ee4d52', 'a7f38ad8-edf5-4f98-8df3-596fd9fad316',
  '9d6d4bf7-35b1-4936-a1c7-3b36982509de'
);


-- ── 4. The DELETEs — same WHERE clauses as step 3, literal ids only ───────
-- Expect "11 rows affected", then "7 rows affected".

DELETE FROM creators WHERE id IN (
  '66c2e483-1405-46b1-b4de-65b929e87a32', 'f1f14b08-c624-448e-9456-ed7e13e3b505',
  'e35f2b2d-948b-4ee1-9bd6-a63f4509f070', '175aa895-335a-4daa-86d2-f2c108b4070c',
  '7ec0eef7-ebb8-499a-816f-83607eb24e4e', '3996f501-eba7-4a7e-b81f-92c36b850a09',
  '9776d53d-7be9-46df-a7f0-930bb0d5787b', '8aa47115-2688-4fe3-9934-8aa93b089f93',
  '5618f7d2-a816-4d68-bd7d-8beb96eb2418', '729242b5-7e50-4013-8a55-49ca52f4cfad',
  '41874097-f254-4a64-8d2c-d793992283cc'
);

DELETE FROM creators_archive WHERE id IN (
  '0d26f4a4-d892-4e1e-84be-f8265bd633a2', '741c20f7-2c39-42a9-8d00-e06a00313cfb',
  '08b00b2f-c510-4563-bd24-906b2a079676', '699a1917-2039-42bb-be2f-c9f61dadb3bb',
  '4fd9a985-b135-465e-89ae-206381ee4d52', 'a7f38ad8-edf5-4f98-8df3-596fd9fad316',
  '9d6d4bf7-35b1-4936-a1c7-3b36982509de'
);


-- ── 5. Afterwards ──────────────────────────────────────────────────────────
-- Re-run both step 3 SELECTs: expect 0 rows each. Re-run step 2: expect 0
-- everywhere, creator_entity included (the CASCADE took its 11 rows).
