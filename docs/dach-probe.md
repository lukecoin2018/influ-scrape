# DACH probe: how every row it writes is tagged

Companion to the 2026-10-11 DACH readiness check. Before any DACH probe
spends money, this file says how its rows will be found again — to measure the
probe, and to remove it if it is judged a failure. **No schema change.** The
tags are things the pipeline already writes; this file supplies the part it
does not: which runs, which brands, which window.

**Rule: a probe is not started until its row is in a table below.** A probe
recorded afterwards from memory is how a cohort becomes unfindable.

---

## 1. Discovery probes — tagged by run id

Hashtag, keyword and seed runs each get a `discovery_runs.id` at start, and
every candidate the run touches gets a `discovery_candidates` row carrying
that `run_id`, the term, the handle and an `outcome`. That is the whole tag.

| What the run wrote | How to find it |
|---|---|
| The run itself | `discovery_runs.id` |
| Every handle it saw, including rejects | `discovery_candidates WHERE run_id = …` |
| New profiles and creators | candidates with `outcome IN ('imported_active', 'unknown_size')` → `social_profiles` on `(platform, handle)` → `creators` on `creator_id` |
| Profiles that already existed | `outcome = 'already_known'` — **not probe rows**, never removed with it |
| The term, on the profile | appended to `social_profiles.discovered_via_hashtags` (terms merge: 43 profiles carry more than one) |

What a run does **not** record: the keyword region (see section 3) and the
follower band beyond `min_followers`/`max_followers`. Write both in the table.

| Run id | Started (UTC) | Platform | Source | Terms | Region | Band | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 2. Brand-feed probes — tagged by brand handle list and time window

The brand feed has no run record. What it writes:

- `brands.feed_scraped_at` / `feed_post_count`, or `tiktok_feed_scraped_at` /
  `tiktok_feed_post_count`, stamped at the end of each brand.
- `partnerships` rows with `discovery_source = 'brand_feed'`, `brand_id`,
  `platform` and `detected_at`. Upserted with `ignoreDuplicates`, so an edge
  that already existed is neither rewritten nor re-stamped.
- New creators, imported with `discovered_via_hashtags = ['brand_feed']` into
  `social_profiles` (in band) or `social_profiles_archive` (out of band),
  stamped `first_discovered_at`.

So the tag is **the brand handles fed, the platform, and the window** they ran
in. Record the window generously — start a minute before pressing Start, end
after the last brand reports.

| Platform | Brand handles (as fed) | Window start (UTC) | Window end (UTC) | Notes |
|---|---|---|---|---|
| | | | | |

A creator counts as a probe row only if it was **first** discovered inside the
window AND has an edge to one of the listed brands inside the window. A
creator who existed before the probe and gained an edge is not a probe row;
the edge is.

## 3. Keyword region A/B — not run

**Asked:** one German keyword, region US vs DE, same settings; report the
candidate overlap and the share of German post language, under $0.50.

**Which platforms honour a region.** Read from the actors' input schemas on
2026-10-11 (Apify API, no run):

- TikTok keyword search (`xmolodtsov~tiktok-search-scraper`, build 0.1.24)
  takes `location`, default `US`, and documents it as **cosmetic**: "Passed
  to TikTok as the region parameter … but TikTok picks results by the
  request's IP address, so this does not return per-country results."
- Instagram keyword search (`apify~instagram-hashtag-scraper`) has no region
  input at all: `hashtags`, `keywordSearch`, `resultsType`, `resultsLimit`.

The Discovery page now offers a region select for TikTok keyword runs, default
unchanged (nothing sent, which is US), so the comparison can be run from the
UI and recorded in section 1.

**Null, written before running:** the region is cosmetic, so US and DE return
the same videos. The probe as specified (`outfit ideen`, 100 items each) was
to be read as:

- 8 or more of the first 10 authors shared → no effect;
- 3 or fewer → inconclusive without a US-vs-US control, because free-plan runs
  exit through Apify's residential proxy, whose country is not pinned;
- in between → inconclusive.

The German-post-language share was to be reported but not read: at the
free-plan cap of 10 items per run it carries an interval of about ±30 points.

**Why it was not run.** The API token in `.env.local` belongs to the Apify
account `timely_bandana`, on the FREE plan. The first start returned
`403 platform-feature-disabled: Monthly usage hard limit exceeded` — the
morning's seed runs had used the month's free credit. Nothing was charged.
On that plan the actor would also clamp `maxItems` to 10 and allow 5 runs a
month. The account has never run this actor; the keyword runs in
`discovery_runs` (most recently 2026-10-10, 103 candidates over three terms)
were made with a different token.

**To run it:** on an account that is not capped, two TikTok keyword runs from
the Discovery page with the same term, results and band, one with region US
(default) and one with Germany, recorded in section 1. If the null holds, the
lever worth testing next is the exit IP (a DE proxy), which is what the actor
says TikTok actually keys on.

---

## Queries

**DO NOT PASTE WHOLE.** Placeholders are marked REPLACE. Every query here is a
SELECT. Removal is not in this file on purpose: after
`docs/incident-2026-08-29-unscoped-delete.md`, any delete is its own reviewed
change, written against the id list a query below produces.

```sql
-- Discovery: what a set of runs created. REPLACE the run ids.
SELECT c.run_id, c.platform, c.handle, c.outcome, p.id AS social_profile_id, p.creator_id
FROM discovery_candidates c
LEFT JOIN social_profiles p ON p.platform = c.platform AND p.handle = c.handle
WHERE c.run_id IN ('REPLACE-run-id-1', 'REPLACE-run-id-2')
  AND c.outcome IN ('imported_active', 'unknown_size')
ORDER BY c.run_id, c.handle;

-- Discovery: outcome funnel per run. REPLACE the run ids.
SELECT run_id, outcome, count(*)
FROM discovery_candidates
WHERE run_id IN ('REPLACE-run-id-1', 'REPLACE-run-id-2')
GROUP BY run_id, outcome
ORDER BY run_id, outcome;

-- Brand feed: the edges written in the window. REPLACE handles and window.
SELECT pa.id, pa.platform, b.instagram_handle, b.tiktok_handle, pa.creator_id, pa.detected_at
FROM partnerships pa
JOIN brands b ON b.id = pa.brand_id
WHERE pa.discovery_source = 'brand_feed'
  AND (b.instagram_handle IN ('REPLACE-handle') OR b.tiktok_handle IN ('REPLACE-handle'))
  AND pa.detected_at BETWEEN 'REPLACE-start' AND 'REPLACE-end'
ORDER BY pa.detected_at;

-- Brand feed: creators first discovered by it, in the window, with an edge to
-- a listed brand in the window. Run once against social_profiles and once
-- against social_profiles_archive. REPLACE handles and window.
SELECT DISTINCT sp.id, sp.platform, sp.handle, sp.creator_id, sp.first_discovered_at
FROM social_profiles sp
JOIN partnerships pa ON pa.creator_id = sp.creator_id
JOIN brands b ON b.id = pa.brand_id
WHERE 'brand_feed' = ANY (sp.discovered_via_hashtags)
  AND sp.first_discovered_at BETWEEN 'REPLACE-start' AND 'REPLACE-end'
  AND pa.discovery_source = 'brand_feed'
  AND pa.detected_at BETWEEN 'REPLACE-start' AND 'REPLACE-end'
  AND (b.instagram_handle IN ('REPLACE-handle') OR b.tiktok_handle IN ('REPLACE-handle'))
ORDER BY sp.first_discovered_at;
```
