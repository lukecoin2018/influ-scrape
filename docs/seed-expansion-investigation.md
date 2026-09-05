# Seed expansion: what it is, what it is not, and why there is no loop

Companion to `docs/location-search-investigation.md`. That document asked how
to find a creator in a **place**. This one records what happened when the most
promising remaining mechanism was measured against that question, and answers
it: **seed expansion is a language mechanism, not a place one.**

Measurements run 2026-09-04 and 2026-09-05. Four Apify runs, all through the
UI. Every comparison below is either free data already paid for or read-only
SQL. Sources at the end.

---

## The mechanism

One creator's **following list** is a curated list. Traversing it yields
accounts that creator chose to follow.

`clockworks/tiktok-followers-scraper`, input
`{profiles: [handle], maxFollowersPerProfile: 0, maxFollowingPerProfile: N}`.
Each item is `{authorMeta, connectedTo, connectionType}` where **`authorMeta` is
the followed account — the candidate — and `connectedTo` is the seed.**

`authorMeta` carries `name`, `fans`, `signature`, `verified`, `ttSeller`,
`bioLink` — the same shape the TikTok search actor returns. So the entire
Discovery funnel applies with one changed step: the free follower filter, the
entity filter, the known-handle check, the reject cache, the candidate log and
the profile import are all untouched.

**Following, not followers.** Who a creator chose to follow is a curated list.
Who follows them is not, and would be dominated by consumers.

---

## What was hoped, and the three measurements that killed it

The original design was a **compounding loop**: expand a seed, promote the
in-band discoveries that match the seed's city, expand those, and let a
geographic cluster concentrate itself. Bogotá was the test case.

### 1. Zero overlap between seeds

Four seeds — `colgo`, `anni_jara`, `daniblog133`, `camila_mirasmithb` — chosen
as Spanish-language, in-band, Bogotá-adjacent. 515 candidates.

    pairwise overlap across the four seeds:  0, 0, 0, 0, 0, 1

Six pairs; five share nothing and one shares a single account. If four seeds
picked from the same city and language occupied the same social neighbourhood,
their following lists would intersect. They do not intersect at all.

This was the first sign and the decisive one. A loop needs a neighbourhood to
walk around in; there isn't one.

### 2. The city null — 42%

Among Spanish-language profiles with a derived place, Bogotá is **42.3%**
(n=26). Expansion's placed candidates came back at approximately the same rate.
A mechanism that returns the base rate is not concentrating anything.

### 3. The country null — 64.7%, and the like-for-like test

After city failed, country was the fallback: promote on matching
`place_country_code` instead of city. Two independent measurements:

**Geotag-derived** — the null the promotion gate would be judged against:

    placed TikTok profiles, post_language = 'es'    34
    of those Colombian (GeoNames 3686110)          22   ->  64.7%

**Bio-derived**, like-for-like and better powered, using the free bio the
following item already carries:

| | n | Colombian |
|---|---|---|
| baseline — existing Spanish-language in-band creators | 50 | **48.0%** |
| expansion — in-band discovered, bio-resolved | 39 | **46.2%** |

    two-proportion z-test:  z = -0.17   not significant at 0.05
    difference:             -1.8 percentage points

Across all 515 discovered (118 bio-resolved): 49.2%, against the same 48.0%
baseline. Two independent slices, both flat. Expansion is very slightly *less*
Colombian than the base it started from.

### The enrichment test that was proposed and NOT run

A 40-creator paid enrichment test was scoped, the handles picked, and then
dropped — because it was underpowered and that should have been computed before
it was proposed. Forty enriched creators yield roughly **6 place-coded
results**. Six observations against a 64.7% null has a confidence interval of
about ±40 points: it cannot separate 65% from 90%, let alone from 46%. Two free
signals already agreed. **Do not re-propose it.**

---

## The distinction that matters, stated precisely

**City was dropped as a SEED-SELECTION and PROMOTION criterion. It was not
dropped as a filter, and `place_city_code` keeps every other job it has.**

| Use of place | Status | Why |
|---|---|---|
| Filtering creators already held — "who is in New York" | **Keeps working, unchanged** | `place_city_code` is how the database knows `carlcurrynyc` is in New York and `jadehatessyou` is in Lambeth. It is the right answer when a brief names a city. |
| Answering a brand asking for a specific city | **Keeps working** | Same column, same query. |
| Choosing which creators to use as expansion seeds | **Dropped** | Seeds selected on place cut the queue by an order of magnitude and buy nothing — the output distribution is the same either way. |
| Deciding which discovered creators to promote to seeds | **Dropped, and with it the loop** | Promoting on matched place re-selects the distribution it started from. There is no gradient to climb. |

City works as a **filter on creators you hold**. It does not work as an
**organising principle for finding more**. Those are different claims and only
the second one failed.

---

## What survives, and it is worth having

Everything measured about expansion as a *flat* source is good:

| | Seed expansion | Keyword search |
|---|---|---|
| in-band rate | **36.5%** (34–44% per seed) | ~28% |
| cost per in-band candidate | **$0.0028** | materially higher |
| free follower count | yes | yes |
| free bio | **92%** | yes, since the xmolodtsov switch |
| already known | **5.2%** of 515 | — |
| Spanish-language bios | 55.7% | — |

So it is the **cheapest on-market candidate source in the pipeline**: one known
creator converts into ~200 candidates, a third of which are in band, at about a
third the per-head cost of anything else. It reliably produces Spanish-speaking
creators, which is the market. It was never going to give Miami, and now we
know it was not going to give Bogotá either.

**This is why the built mechanism is flat.** A fourth `searchSource`, seeds
chosen by an operator from a queue, expanded once, marked `seed_expanded_at`,
and nothing else. No promotion, no recursion, no place criterion.

---

## The selection criteria that shipped

    post_language IS NOT NULL      the mechanism is a LANGUAGE one
    following_count >= 150         the seed's own ceiling on what it can return
    import_status = 'active'       in band — a creator we want more of
    seed_expanded_at IS NULL       traversed once, never on a schedule
    platform = 'tiktok'            the only platform with a following-list actor

### A seed's ceiling is its own following count

Asking for 200 from an account following 16 returns 16. `camila_mirasmithb`
follows 16, which is why its share of the four-seed sample is one candidate.
This is a property of the seed, not a failure, and it is why the queue filters
on `following_count` and the panel shows it per row.

### The queue is small today because enrichment is young, and it grows on its own

Measured 2026-09-05:

    tiktok, import_status = 'active'        3,712
    + following_count >= 150                2,362   <- the eventual pool
    + post_language present                   334   <- today's queue
      of which es                              76
      of which en                             235
      of which pt                               2

**Read this as a consequence, not a limitation.** `post_language` is written by
the enrichment pass, and the column only came into existence on 2026-09-03
(`docs/migrations/2026-09-03-post-place-language-biolink.sql`). So it exists
only on creators enriched *since* that change. The 334 is not a property of the
mechanism or of the follower threshold — it is a count of how far the
re-enrichment has got.

**As TikTok creators re-enrich, the queue grows toward 2,362** — every active
creator following 150+ picks up a `post_language` the first time it is enriched
and becomes selectable. Nothing needs to be built for that to happen; the queue
query already reads the column. A full TikTok re-enrichment sweep should leave
most of the 2,362 eligible, which is roughly a seven-fold increase over today
and puts the Spanish pool in the high hundreds rather than at 76.

So the small number means "expand the seeds you have while enrichment catches
up", not "this mechanism is narrow".

The bio heuristic `detected_language` would offer more right now (647 es, 1,308
en) and was deliberately not used as the criterion — the actor's language call
beat the heuristic in all four measured disagreements, and a seed chosen on a
worse signal spends real money. It remains available as a lever if a market's
queue runs dry before enrichment catches up, but it is a decision to take
knowingly rather than a fallback to add quietly.

---

## Not modelled: the profile scrape may be unnecessary

The cost estimate prices a $0.005 profile scrape for every in-band candidate,
exactly as the search sources do. **The following item already carries `name`,
`nickName`, `fans`, `signature`, `following`, `video`, `heart`, `verified`,
`avatar` and `profileUrl`** — measured at 100% across the 516 items already
paid for, except `signature` at 90.7%. That is a superset of everything
`mapTikTokProfile` writes, and on two fields it is strictly better: the mapper
hardcodes `is_verified` to `false`, and takes `full_name` from `tagline`, which
has produced exactly one non-empty value across 3,458 TikTok creators.

`bioLink` is **not** among them: it appears on the item's `connectedTo` (the
seed) and is 0% on candidates, as are `createTime` and `commerceUserInfo`. It
costs nothing today either way, because `website` is written as `''` regardless.
The full table is ledger item 25.

Importing straight off the free item would remove that term:

    200-entry seed, with the profile scrape     ~$0.57
    200-entry seed, importing off the free item  ~$0.20

That is a real saving and a **separate change**, because it would make seed
imports structurally different from every other source's. Nobody has chosen it.
Until they do, the estimate charges for the scrape and therefore reads high.

---

## How each claim here was verified

| Claim | Source |
|---|---|
| Actor input shape | Apify run inputs for `LWOz58cSAqNgkKCcO` and `2VLVNE2M6uunrPoih`, read from their key-value stores 2026-09-05 |
| `authorMeta` is the candidate, `connectedTo` the seed | Dataset `HIpIKKxKHBfb6FlVW`, item 1: `connectionDescription: "colgo is following wzysg4"` with `authorMeta.name = wzysg4`. Pinned by `lib/seedExpansion.test.ts` |
| $0.001/result + $0.001/run start | Actor `pricingInfos`, PAY_PER_EVENT, FREE tier, read 2026-09-05 |
| Zero overlap 0,0,0,0,0,1 | Four datasets, pairwise handle intersection |
| In-band 36.5%, cost $0.0028/in-band | Same four datasets against a 30k–500k band |
| Bogotá 42.3% (n=26), Colombia 64.7% (n=34) | Read-only SQL on `social_profiles`, `post_language = 'es'` with a derived place |
| Baseline 48.0% (n=50) vs expansion 46.2% (n=39), z = −0.17 | Bio-derived country on both sides, like-for-like |
| Seed queue counts (3,712 / 2,362 / 334 / 76 / 235) | Read-only PostgREST counts with `Prefer: count=exact`, 2026-09-05 |

No live run was started for this document. No row was written.
