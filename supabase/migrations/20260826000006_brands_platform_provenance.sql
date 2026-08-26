-- Record which platform a brand was actually mentioned on.
--
-- The enrich pipeline files every detected brand handle into
-- brands.instagram_handle regardless of the source post's platform, and
-- TikTok posts outnumber Instagram ones 75,239 to 60,503. The result: 487 of
-- 2,210 verified brands (22%) have only ever been mentioned in TikTok posts,
-- and their "Instagram handle" may not exist on Instagram at all. Six of them
-- (medicube, armani, nars, ulta, hourglass, shein_official) returned 1 post
-- and 0 candidates when the brand-feed sweep scraped them.
--
-- instagram_handle is deliberately left intact. It is the de-facto identity
-- key: upsert_brand, saveBrandsToTable's existence check, save-partnerships'
-- brand lookup and the brand_aliases join
-- (lower(alias) = lower(instagram_handle)) all key off it. Nulling it for
-- TikTok-only brands would break the alias join for exactly the brands being
-- classified, and would make saveBrandsToTable create duplicates on the next
-- enrich run.
--
-- mention_platforms carries the evidence instead. It is derived from
-- creator_posts.platform, so it says where we saw the brand, not where we
-- guess it lives.
--
-- Being mentioned on both platforms is NOT a conflict to resolve: 277 brands
-- are, and gymshark (IG 77 / TT 40), rhode (52/58), sephora (34/41) and
-- adidas (22/30) genuinely run accounts on both under the same handle. Those
-- get both array entries and both handle columns set to the same value.

alter table brands
  add column if not exists tiktok_handle varchar(64),
  add column if not exists mention_platforms text[];

comment on column brands.tiktok_handle is
  'The brand''s TikTok handle, when it has been seen mentioned in TikTok posts. Often identical to instagram_handle — a brand running accounts on both platforms is the normal case, not a conflict.';

comment on column brands.mention_platforms is
  'Platforms this brand has actually been mentioned on, from creator_posts.platform. {tiktok} alone means the Instagram handle is unverified and probably does not exist — the brand-feed queue can skip these. NULL means no attributed mentions yet.';

-- The brand-feed queue filters on this; GIN supports the array containment
-- and overlap operators it needs.
create index if not exists brands_mention_platforms_idx
  on brands using gin (mention_platforms);

create index if not exists brands_tiktok_handle_idx
  on brands (tiktok_handle)
  where tiktok_handle is not null;
