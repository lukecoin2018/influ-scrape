# TikTok truncation repair — verified plan (parked)

**Status:** verified, not executed. Parked to resume as a separate project.
**Cost to complete:** $4.68. **Already spent verifying:** $0.16.

## The defect

`mapTikTokPost` derived `tagged_accounts` from a caption regex. TikTok captions
render mentions as `@DisplayName`, not `@username`, so the regex stored the
display text truncated at the first illegal character.

Measured across the 3,374 TikTok posts carrying brand mentions:

- **2,798 of 7,777 mention occurrences (36%)** are truncated display names
- spanning **1,143 distinct handles**, of which **1,013 reached `brand_aliases`**
- **231 are classified `entity_type='brand'` AND `verified`**
- concentrated in **1,559 posts** (several truncations often share a caption)

The extractor is fixed (commit `f2111ea`, refined in the commit that added this
file). This document covers repairing the data already stored.

## Why a recompute cannot fix it

`creator_posts` stores `caption` but never stored the actor's resolved mention
fields. Splitting the truncations by whether the stored caption can resolve them:

| | occurrences | handles |
|---|---|---|
| Fixable from stored caption (`@Kiehl's`, `@L'Oréal`) | 159 | 78 |
| **Not fixable — display name split by a space** (`@Huda Beauty`) | **2,767** | **1,129** |

**Compute-only recovers 5%.** The rest requires re-fetching from the actor.

## Why URL scraping, not feed scraping

Feed scraping fetches a creator's *most recent* N posts, not the posts that
contain the truncations. 59% of affected posts are older than two months.

| approach | results | cost | coverage |
|---|---|---|---|
| **URL scrape** | **1,559** | **$4.68** | **100% of targets** |
| feed @15 posts | 11,265 | $33.80 | recent only |
| feed @16 (avg depth needed) | 12,016 | $36.05 | ~half the creators |
| feed @43 (deepest creator) | 32,293 | $96.88 | complete, 21x the cost |

Reaching the same posts by feed needs 15.7 posts back on average and 43 for the
deepest creator — and that counts only *stored* posts, so real feed depth is
greater.

## Verified: the actor

`clockworks/tiktok-video-scraper` (`S5h7zRLfKFEr8pdj7`), **$0.003/result** on the
FREE tier. Takes `postURLs` as its primary input. Confirmed by live run
`sfQmsqa3UzY08rZHL` against a real affected post:

```
caption           "#ad ... @Chester Cheetah @Doritos @RUFFLES"
stored today      ["chester"]                                    <- the bug
mentions[]        ["@Chester Cheetah","@Doritos","@RUFFLES"]     display names
detailedMentions  name=cheetos / doritos / officialruffles       REAL usernames
```

**Use `detailedMentions[].name` only.** `mentions[]` is not a usable second
source: it misses `cheetos` entirely and yields `ruffles` for an account
actually called `officialruffles`. The extractor prefers `detailedMentions` and
falls back to `mentions` only when the field is absent.

## Verified: deletion rate

50-URL stratified probe, run `Dg4MjLPZdVHkJdRvR`:

| band | sampled | resolved | lost |
|---|---|---|---|
| < 2 months | 16 | 16 | 0 |
| 2–6 months | 15 | 15 | 0 |
| 6–12 months | 12 | 12 | 0 |
| > 12 months | 7 | 7 | 0 |
| **total** | **50** | **50 (100%)** | **0** |

All 50 carried `detailedMentions`. **Projected loss over 1,559: ~0.**

Caveat: n=50. Billing is per dataset item, so an error item still costs — budget
on 1,559 attempts, not 1,559 successes.

## The write mechanism

Do **not** use the enrich upsert path. It keys on
`onConflict: 'social_profile_id,post_id'` and rewrites the whole mapped row,
overwriting `caption`, metrics and `posted_at`.

Instead: we hold `creator_posts.id` for every affected row, so issue a targeted
`PATCH` setting only

- `tagged_accounts` — from `detailedMentions[].name`
- `detected_brands`, `sponsor_signals`, `is_sponsored` — from re-running
  `detectBrandsInPost` on the corrected tagged accounts

Nothing else on the row is touched.

Two deliberate consequences:

- `social_profiles.enriched_at` does **not** advance. This is a repair, not a
  re-enrichment; advancing it would corrupt the staleness queue.
- No free metrics refresh. The video scraper does return
  `diggCount`/`playCount`/`commentCount` for the same rows at no extra cost, so
  refreshing them is available as an opt-in flag.

## Running it

```bash
# Regenerate the target list (do not trust a snapshot — new posts arrive)
node scripts/list-truncated-post-urls.mjs --out=/tmp/urls.json
```

Then scrape those URLs through `clockworks/tiktok-video-scraper` in batches, and
PATCH each `creator_posts` row by id.

## Downstream work this blocks

`docs/partnerships-as-source-of-truth.md` — backfilling `partnerships` from
`creator_posts.detected_brands` cannot start until this repair lands, or ~1,143
fragment handles become permanent brand edges in what is meant to become the
system of record.

## Sequencing when this resumes

1. This repair (`$4.68`).
2. `brand_aliases` cleanup — only after, so fragments stop being reinforced.
   `scripts/resolve-truncated-brands.mjs` produces the review list: 1,020
   fragments, 134 resolving to handles already held (`huda` → `hudabeauty`,
   `hourglass` → `hourglasscosmetics`, `ulta` → `ultabeauty`).
3. The queue rule for the ≥80%-truncated set — deliberately deferred, because
   that set will shrink substantially once clean handles land, and hard-coding
   today's 182 would bake in a number that is about to change.

## What is already live and unaffected

`brands.mention_platforms` and `brands.tiktok_handle` are backfilled for all
11,503 brands with attributed mentions. Excluding `mention_platforms = {tiktok}`
from the Instagram sweep works today and is independent of this repair.

Note ~37% of the *verified* TikTok-only set are truncation fragments rather than
genuinely TikTok-only brands, so the exclusion is correct but its size will
change once this repair lands.
