-- Split import_status by direction.
--
-- 'out_of_range' becomes 'out_of_range_high' (above max) and
-- 'out_of_range_low' (below min). Exclusion behaviour is unchanged: every
-- pipeline filter tests `import_status = 'active'`, so both values are
-- excluded identically and none of those 23 queries needed touching.
--
-- The split exists because the two groups have opposite futures. A
-- below-range creator can grow into range and be promoted back to 'active';
-- an above-range one will not, and is better treated as a separate
-- mega-creator dataset.
--
-- The columns are plain varchar with no CHECK constraint, so no type change
-- is required — this migration re-labels existing rows and corrects the
-- column documentation. The partial indexes are also unaffected: their
-- predicate is `import_status <> 'active'`, which still covers both values.

update social_profiles
set import_status = case
      when follower_count is not null and follower_count > 500000 then 'out_of_range_high'
      else 'out_of_range_low'
    end
where import_status = 'out_of_range';

update creators c
set import_status = case
      when exists (
        select 1 from social_profiles sp
        where sp.creator_id = c.id and sp.import_status = 'out_of_range_high'
      ) then 'out_of_range_high'
      else 'out_of_range_low'
    end
where c.import_status = 'out_of_range';

comment on column social_profiles.import_status is
  '''active'' = eligible for the enrichment/intelligence/embedding pipelines. ''out_of_range_high'' = follower_count above the configured import max. ''out_of_range_low'' = below the min. Both are excluded from every spend pipeline identically; the direction is kept because below-range creators can later grow into range and be promoted, while above-range ones are a separate mega-creator population. Source of truth for creators.import_status.';

comment on column creators.import_status is
  'Roll-up of social_profiles.import_status. ''active'' when any profile is active; otherwise the direction of the profiles, with ''out_of_range_high'' winning a mixed set since being large on any platform makes a creator a mega-creator rather than one who might grow into range. Exists so the creators-based embedding queries can filter in one predicate.';
