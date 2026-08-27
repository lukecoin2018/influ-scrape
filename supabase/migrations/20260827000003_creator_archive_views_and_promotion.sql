-- Query surfaces and the promotion path for archived creators.
--
-- Run after the data move. Split out so the views reflect the final table
-- shapes and promote_creator() can be replaced independently of the migration.

begin;

-- ── Views ───────────────────────────────────────────────────────────────────
--
-- The two populations share storage but are queried apart. This is what makes
-- one archive pair equivalent to two: named destinations at the query surface,
-- one schema underneath, so a column added to creators never has to be added
-- in three places.

create or replace view v_creators_below_min as
  select * from creators_archive where archive_reason = 'below_min';

create or replace view v_creators_above_max as
  select * from creators_archive where archive_reason = 'above_max';

comment on view v_creators_below_min is
  'Creators archived for falling below the follower minimum. These can grow into range and be promoted back — see promote_creator(). Ranked promotion candidates come from social_profiles_archive.import_status_follower_count compared against a fresh scrape.';

comment on view v_creators_above_max is
  'Creators archived for exceeding the follower maximum. Not promotion candidates; this is the mega-creator population, kept for the partnership intelligence its edges carry.';

-- v_social_profiles_all: every profile regardless of population.
--
-- Needed because brand-feed edge recording resolves handles through
-- social_profiles. After separation that table no longer contains archived
-- creators, so re-scraping a brand would silently stop re-recording their
-- edges — losing exactly the celebrity intelligence the archive exists to
-- keep. Lookups that must span populations use this view; lookups that should
-- only see sellable creators keep using social_profiles directly.
--
-- Columns are listed explicitly rather than SELECT *: the archive carries two
-- extra columns, and a UNION requires matching lists.

create or replace view v_social_profiles_all as
  select
    id, creator_id, platform, handle, follower_count, following_count,
    posts_count, engagement_rate, is_verified, profile_pic_url, profile_url,
    bio, website, platform_data, discovered_via_hashtags, discovery_count,
    first_discovered_at, last_updated_at, enrichment_data, enriched_at,
    posts_scraped_count, detected_language, detected_country, detected_city,
    detected_email, ai_summary, intelligence_data, intelligence_updated_at,
    detected_niche, import_status, import_status_at,
    import_status_follower_count,
    'active'::varchar as population
  from social_profiles
  union all
  select
    id, creator_id, platform, handle, follower_count, following_count,
    posts_count, engagement_rate, is_verified, profile_pic_url, profile_url,
    bio, website, platform_data, discovered_via_hashtags, discovery_count,
    first_discovered_at, last_updated_at, enrichment_data, enriched_at,
    posts_scraped_count, detected_language, detected_country, detected_city,
    detected_email, ai_summary, intelligence_data, intelligence_updated_at,
    detected_niche, import_status, import_status_at,
    import_status_follower_count,
    archive_reason as population
  from social_profiles_archive;

comment on view v_social_profiles_all is
  'Every social profile across all populations, with a population column. Use where a lookup must span populations — brand-feed edge recording in particular. Do NOT use for pipeline queues or public counts; those must see only sellable creators and should query social_profiles directly.';

-- v_creators_all: every creator regardless of population.
--
-- Same rationale as v_social_profiles_all. Hashtag sponsorship discovery
-- resolves a creator handle before writing a partnership edge; if that lookup
-- only saw creators, edges for archived creators would be silently dropped.

create or replace view v_creators_all as
  select c.*, 'active'::varchar as population from creators c
  union all
  select
    a.id, a.instagram_handle, a.full_name, a.bio, a.follower_count,
    a.following_count, a.posts_count, a.engagement_rate, a.is_verified,
    a.is_business_account, a.category_name, a.profile_pic_url, a.profile_url,
    a.website, a.discovered_via_hashtags, a.discovery_count,
    a.first_discovered_at, a.last_updated_at, a.status, a.notes, a.is_featured,
    a.display_order, a.content_tags, a.display_name, a.primary_platform,
    a.total_followers, a.embedding, a.embedding_text, a.embedded_at,
    a.primary_language, a.country, a.city, a.contact_email, a.ai_embedded,
    a.import_status,
    a.archive_reason as population
  from creators_archive a;

comment on view v_creators_all is
  'Every creator across all populations, with a population column. Use where a lookup must span populations — resolving a handle before writing a partnership edge in particular. Do NOT use for pipeline queues or public counts.';

-- ── Promotion ───────────────────────────────────────────────────────────────
--
-- A below-min creator growing past the minimum moves back. Previously a single
-- UPDATE of import_status; now a move between tables, so it is a function to
-- keep it atomic and in one place.
--
-- Partnership edges are untouched: they reference creator_registry, which does
-- not change. The registry row's current_population is updated, and the id
-- itself never moves.

create or replace function promote_creator(p_creator_id uuid)
returns table (promoted_creator uuid, profiles_moved int)
language plpgsql as $$
declare
  n_profiles int;
  v_reason   varchar;
  n_c_cols   int;
  n_sp_cols  int;
begin
  -- The column lists below are explicit, so a column added to creators later
  -- would be silently dropped on promotion. Fail loudly instead: if the shape
  -- has changed, this function needs updating before it can be trusted.
  select count(*) into n_c_cols  from information_schema.columns where table_name = 'creators';
  select count(*) into n_sp_cols from information_schema.columns where table_name = 'social_profiles';

  if n_c_cols <> 35 or n_sp_cols <> 32 then
    raise exception
      'promote_creator is pinned to creators(35 cols)/social_profiles(32 cols) but found %/%. Update its column lists before promoting, or data will be dropped.',
      n_c_cols, n_sp_cols;
  end if;

  select archive_reason into v_reason from creators_archive where id = p_creator_id;

  if v_reason is null then
    raise exception 'creator % is not archived', p_creator_id;
  end if;

  -- Above-max creators do not grow back into range. Promoting one is almost
  -- certainly a mistake, so it must be deliberate rather than incidental.
  if v_reason <> 'below_min' then
    raise exception
      'creator % is archived as %, not below_min. Above-max creators are not promotion candidates; move it deliberately if that is really intended.',
      p_creator_id, v_reason;
  end if;

  -- Creator first: social_profiles.creator_id references creators.
  -- Explicit column lists, not (a.*)::creators.
  --
  -- creators_archive has two columns creators does not, and PostgreSQL will
  -- not cast between composite types of different shape — the row cast raises
  -- "cannot cast type creators_archive to creators". Naming the columns on
  -- both sides also makes the copy order-independent, so it cannot silently
  -- misalign if the archive's column order ever diverges.
  insert into creators (
    id, instagram_handle, full_name, bio, follower_count, following_count,
    posts_count, engagement_rate, is_verified, is_business_account,
    category_name, profile_pic_url, profile_url, website,
    discovered_via_hashtags, discovery_count, first_discovered_at,
    last_updated_at, status, notes, is_featured, display_order,
    content_tags, display_name, primary_platform, total_followers,
    embedding, embedding_text, embedded_at, primary_language, country,
    city, contact_email, ai_embedded, import_status
  )
  select
    id, instagram_handle, full_name, bio, follower_count, following_count,
    posts_count, engagement_rate, is_verified, is_business_account,
    category_name, profile_pic_url, profile_url, website,
    discovered_via_hashtags, discovery_count, first_discovered_at,
    last_updated_at, status, notes, is_featured, display_order,
    content_tags, display_name, primary_platform, total_followers,
    embedding, embedding_text, embedded_at, primary_language, country,
    city, contact_email, ai_embedded, import_status
  from creators_archive where id = p_creator_id;

  insert into social_profiles (
    id, creator_id, platform, handle, follower_count, following_count,
    posts_count, engagement_rate, is_verified, profile_pic_url,
    profile_url, bio, website, platform_data, discovered_via_hashtags,
    discovery_count, first_discovered_at, last_updated_at, enrichment_data,
    enriched_at, posts_scraped_count, detected_language, detected_country,
    detected_city, detected_email, ai_summary, intelligence_data,
    intelligence_updated_at, detected_niche, import_status,
    import_status_at, import_status_follower_count
  )
  select
    id, creator_id, platform, handle, follower_count, following_count,
    posts_count, engagement_rate, is_verified, profile_pic_url,
    profile_url, bio, website, platform_data, discovered_via_hashtags,
    discovery_count, first_discovered_at, last_updated_at, enrichment_data,
    enriched_at, posts_scraped_count, detected_language, detected_country,
    detected_city, detected_email, ai_summary, intelligence_data,
    intelligence_updated_at, detected_niche, import_status,
    import_status_at, import_status_follower_count
  from social_profiles_archive where creator_id = p_creator_id;

  get diagnostics n_profiles = row_count;

  delete from social_profiles_archive where creator_id = p_creator_id;
  delete from creators_archive        where id = p_creator_id;

  -- Stamp columns are cleared: the classification they recorded no longer
  -- applies, and a stale snapshot must not outlive the stamp it belonged to.
  update social_profiles
  set import_status = 'active',
      import_status_at = null,
      import_status_follower_count = null
  where creator_id = p_creator_id;

  update creators set import_status = 'active' where id = p_creator_id;

  update creator_registry set current_population = 'active' where id = p_creator_id;

  return query select p_creator_id, n_profiles;
end $$;

comment on function promote_creator(uuid) is
  'Moves a below_min creator and its profiles back into creators/social_profiles atomically. Partnership edges are untouched — they reference creator_registry. Refuses above_max creators, which are not promotion candidates.';

commit;
