-- Per-brand casting profile: how many partnered creators fall below, inside
-- and above a follower band, so brands can be ranked by whether they actually
-- cast the creators we care about.
--
-- The parameter columns are not optional bookkeeping. A stored count is
-- uninterpretable without the band and window it was computed under — the
-- moment either changes, you cannot tell a stale row from one computed under
-- different settings. They are stored alongside every count.
--
-- Raw counts only. No ratio is stored: nakdfashion is 100% in-band on 4
-- creators, which is exactly the noise a stored ratio would float to the top.
-- The sample floor belongs at ranking time, against casting_sample_size.
--
-- Deliberately distinct from recalculate_brand_stats(), which owns
-- total_partnerships_detected, avg/min/max_partner_follower_count,
-- preferred_creator_tier and active_niches. The casting_ prefix has no overlap
-- with any of those, so that RPC can never clobber these columns and the
-- casting updater never calls it.

alter table brands
  add column if not exists casting_in_range_count integer,
  add column if not exists casting_below_count integer,
  add column if not exists casting_above_count integer,
  add column if not exists casting_unknown_count integer,
  add column if not exists casting_sample_size integer,
  add column if not exists casting_computed_at timestamptz,
  add column if not exists casting_window_days integer,
  add column if not exists casting_min_followers integer,
  add column if not exists casting_max_followers integer;

comment on column brands.casting_sample_size is
  'Distinct creators this brand partnered with inside the window — the denominator. Apply a floor against this when ranking; a 100% in-range rate over 4 creators is noise.';

comment on column brands.casting_window_days is
  'Window the counts were computed over, in days, against coalesce(posted_at, detected_at). Stored because the counts mean nothing without it.';

comment on column brands.casting_min_followers is
  'Lower bound of the band the counts were computed under. Stored so a change of band is distinguishable from a stale row.';

comment on column brands.casting_max_followers is
  'Upper bound of the band the counts were computed under. Stored so a change of band is distinguishable from a stale row.';

-- Ranking by casting fit, floored on sample size.
create index if not exists brands_casting_fit_idx
  on brands (casting_in_range_count desc nulls last, casting_sample_size desc)
  where casting_in_range_count is not null;
