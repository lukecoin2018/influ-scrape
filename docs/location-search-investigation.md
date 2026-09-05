# Location search: investigation before building

Read-only investigation, 2026-09-02. Nothing was built, no Apify run was
started, no row was written. Sources for every number are recorded at the end.

The request was "location search, and eventually location combined with keyword
— a creator in Miami doing a try-on haul", for an English and Spanish-speaking
market.

---

## The framing that decides everything else

**"A creator in Miami" and "a video shot in Miami" are different populations,
and only the first one is wanted.**

This is not a quibble. It is the difference between the two mechanisms available
and it points at opposite platforms:

- A **geotag** — Instagram's `locationName`/`locationId` on a post, TikTok's
  `videoMeta.locationCreated` — records where a piece of content was made. A
  tourist filming in Miami produces a Miami-tagged post and is not a Miami
  creator. A Miami creator filming indoors produces nothing at all.
- A **bio or profile text** — "📍Miami", "based in Medellín", a 🇨🇴 flag — is
  the creator's own claim about where they are. It is what a person writes when
  they want to be found by brands in their city, which is exactly the population
  being searched for.

Bookability is the point. A creator worth finding is one who can be engaged
repeatedly from a known market, not one who happened to be standing somewhere.

**So: bios and profile text, not geotags.** Geotag-based location actors are
available and are the wrong instrument. They are recorded below under what was
rejected, with the reason, so this does not get rediscovered as an idea.

---

## What the search actors can and cannot do

Neither actor currently in use can search by location. Checked against each
actor's published input schema.

| Actor | Location input | Notes |
|---|---|---|
| `apify/instagram-hashtag-scraper` | none | Four inputs: hashtags, keywordSearch, resultsType, resultsLimit |
| `clockworks/tiktok-scraper` | `proxyCountryCode` only | Controls which country's content is *visible to the scraper*, not what is searched |

`proxyCountryCode` is worth naming precisely because it looks like a location
filter and is not. It changes content availability, the way a VPN would. It says
nothing about where the creator is.

So location cannot be expressed as a query. It has to be read off results
obtained some other way — which makes it a **filter**, not a search source, and
that changes where it belongs in the pipeline.

### Free signals on the search item, all three currently discarded

| Platform | Field | Granularity | Answers |
|---|---|---|---|
| Instagram | `locationName`, `locationId` on the post | venue / place | where the **post** was tagged |
| TikTok | `videoMeta.locationCreated` | country code (`"GB"`) | where the **video** was created |
| TikTok | `authorMeta.signature` (the bio) | whatever was written | where the **creator says** they are |

An unbounded grep across `lib/`, `app/`, `supabase/` and `docs/` for
`locationCreated`, `locationName` and `locationId` returns zero hits. None of
the three is read today.

The first two are geotags and are the wrong instrument per the framing above.
**The third is the right one, is free, and is already being stored.**

### The asymmetry, and it is the same one as the follower band

`authorMeta.signature` is captured by `extractAuthorMeta` and written to
`discovery_candidates.author_signature` by `writeCandidates`, for every
candidate — including the ones rejected pre-scrape, which never cost anything.

Instagram's hashtag and keyword posts carry `ownerUsername`, `ownerFullName` and
`ownerId` and nothing else about the account. There is no bio on the search item.

So location-from-bio is **free on TikTok and paid on Instagram**, which is
precisely the asymmetry `authorMeta.fans` produced. Location and keyword combine
cheaply on one platform and expensively on the other. That is an argument for
building this TikTok-first rather than symmetrically, and it compounds with the
yield finding: enrichment on the keyword-discovered TikTok cohort found
partnership edges on most of the sample (20, 19, 11, 11, 7, 7, 6 across it),
with healthy engagement and recent activity. The keyword source produces
creators who demonstrably do brand deals — which is the yield measure that
matters, not in-band count.

### What was rejected, and why

Instagram geotag actors exist and work — `instaprism`, `apidojo`,
`scraper-engine` and others take a place ID or URL and return posts tagged
there, at roughly $0.025/location plus $0.0005/post. They would slot in as a
third `search_source` beside `hashtag` and `keyword`; the route already parses
that enum.

**Not recommended.** They answer the video-shot-in-Miami question, and they
answer it on Instagram, where every candidate costs a profile scrape to
evaluate. That is paying full price for the population with the weaker signal.
If a geotag source is ever built it should be because post-location is wanted
for its own sake, not as a proxy for creator location.

---

## The larger finding: nothing reads location

Location is detected, normalized (half the time — see below), and embedded. No
query path consumes any of it.

- `app/api/database/get-creators/route.ts` has no `country` or `city` predicate.
  It filters search, status, platform and follower range only.
- An unbounded grep for `embedding` across every `.ts`, `.tsx`, `.sql` and
  `.mjs` returns writers, status counters and nav links. There is no vector
  search route, no RPC, no `match_creators`.

So a location *search source* would feed a filter that does not exist, and
"a creator in Miami doing a try-on haul" has nowhere to run even for creators
already in the database.

### The data is already there, and it is not sparse

Measured 2026-09-02, read-only:

| | count | of |
|---|---|---|
| creators total | 8,463 | |
| creators with a country | 6,026 | 71% |
| creators with a city | 3,091 | 37% |
| social_profiles with `detected_country` | 6,052 of 8,462 | 72% |
| TikTok profiles with `detected_country` | 2,472 of 3,528 | 70% |

Per-country, against the target market:

| country | creators | | country | creators |
|---|---|---|---|---|
| United States | 1,758 | | Spain | 605 |
| United Kingdom | 436 | | Colombia | 604 |
| Australia | 130 | | Mexico | 257 |
| Canada | 101 | | Peru | 76 |
| Ireland | 8 | | Argentina | 65 |
| | | | Chile | 37 |

**4,077 of 8,463 creators (48%) are already in the target market.**
**1,683 of them are in-band TikTok creators.**

That population exists today. It needs no new discovery run, no new actor, and
no migration to query. It is worth more than any new discovery source because it
works on the whole database rather than on new candidates.

### `v_creator_summary` already exposes it

The view's definition is not in any tracked migration, so it was read from the
live database. It carries:

    country, city, instagram_country, tiktok_country,
    primary_language, instagram_language, tiktok_language,
    instagram_followers, tiktok_followers, total_followers, ...

`get-creators` reads this view with `select('*')`, so the country columns are
already coming back over the wire and being ignored. **Adding a country filter
is a route change with no migration and no view change.**

The view does NOT carry `import_status`. That turns out not to matter: all 76
non-active rows in `creators` are `unknown_size`, and there are zero
`out_of_range_high` and zero `out_of_range_low` — the archive separation worked,
and `creators` is the in-band population by construction.

---

## Two defects in the location machinery already shipped

### D1. Only one of the two writers normalizes

There are two writers to `detected_country`/`country`:

- `app/api/extract-locations/route.ts` — Claude over `ai_summary`. Imports
  `canonicalCountry`, `canonicalCity` and `isPlausibleCityCountryPair` and
  applies all three.
- `app/api/intelligence/analyze/route.ts` — the regex `detectLocation(bio)`.
  Imports none of them. Checked against its full import list and by grepping the
  function names: zero references.

So `detectLocation` writes `'UAE'`, which `COUNTRY_ALIASES` exists specifically
to canonicalize to `'United Arab Emirates'`, and writes raw city strings that
`canonicalCity` exists specifically to reject (US states, admin regions,
descriptive regions like "South Florida").

**Confirmed in the data, not inferred:**

    detected_country = 'UAE'                    21 rows
    detected_country = 'United Arab Emirates'   23 rows

A filter on the canonical form misses 21 of 44 UAE profiles. This is the exact
failure mode a location filter would hit, and it is in the way of the feature
rather than beside it.

**Fix before the filter, not after.** Both are pure functions in modules that
import no client, so this is unit-testable under ledger item 9's rule.

### D2. The market with the worst coverage is the target market

`detectLocation`'s `cityMap` resolves 34 countries. Cross-referencing its values
against its own `flagMap`: **Colombia, Chile and Peru have flag entries and not
one city between them.** Bogotá, Medellín, Santiago and Lima all fall through to
null unless the creator uses a flag emoji.

Spanish-language cities in the map total five — Madrid, Barcelona, Valencia,
Mexico City, Buenos Aires. Germany has nine; the United Kingdom has six. The
table was built for a European market and is now pointed at LatAm.

**Caveat, stated because the numbers look like they contradict this:** Colombia
still shows 604 creators. That count cannot be attributed to the regex — the
Claude pass over `ai_summary` writes the same columns, and flag emojis resolve
without any city entry. The gap is real in `detectLocation` specifically; how
much the Claude pass compensates for it has not been measured, and should be
before deciding how much the city table matters.

### D3 (structural). Four city→country tables, three files

`cityMap` in the analyze route, and `CITY_COUNTRY_PLAUSIBILITY`,
`TRUNCATED_CITY_MAP` and `CITY_ALIASES` in `lib/location-normalization.ts`. No
shared source. This is ledger item 1's pattern, and it should be consolidated
**before** a fourth consumer is added rather than after.

---

## `searchSection: '/video'` — checked, and it works

`lib/apify.ts` sends `searchSection: '/video'`, while the actor's current input
schema documents `""`, `"Video"` and `"Profile"`. That looked like the
declared-but-absent-field failure this project has been bitten by three times,
and it was raised as a probable defect.

**It is not a defect. The check disproved it.** Read from the stored runs of
2026-08-29/30, which cost nothing to inspect:

- The resolved input records `"searchSection":"/video"` — the actor accepted the
  value rather than rejecting or blanking it. A hashtag-mode run from the same
  evening records `"searchSection":""`, so the field is not simply being
  overwritten with a default.
- The log settles it: every keyword run logs `[SEARCH_VIDEOS]` against
  `https://www.tiktok.com/search/video?q=...`, which is the video search
  section. The hashtag run logs `[HASHTAG_CONTINUATION]` against
  `https://www.tiktok.com/tag/...`.

So `/video` is a working legacy alias, keyword runs did search video
descriptions, and deferred-cleanups item 21 measured what it says it measured.
The documented spelling is `"Video"`; switching to it would be tidier but is not
a bug fix, and changing a value that is demonstrably working carries more risk
than the tidiness is worth. **Leave it, and record that it was verified** — the
next reader will otherwise re-raise it from the schema exactly as it was raised
here.

`searchSection: "Profile"` remains available and untested. It would search
account names and bios rather than video descriptions, which is a candidate
mechanism for location.

### What the logs did show: keyword search is erratic, not slow

The same logs carry repeated
`Failed to parse TikTok response: Unexpected end of JSON input` warnings with up
to five retries per page, and video pages arriving in fragments of 5-12 against
the hashtag path's 30. The crawler recovers — item counts come back near-full —
but wall time swings by a factor of five for identical work:

| term | asked | got | seconds |
|---|---|---|---|
| `fashion haul` | 200 | 200 | 56 |
| `london fashion week` | 200 | 200 | 127 |
| `grwm` | 200 | 170 | 185 |
| `try on haul` | 200 | 200 | 289 |
| `#try on haul` (hashtag) | 50 | 50 | 14 |

The 289s figure that `DISCOVERY_BUDGET_SECONDS` was sized against is the **worst
case, not the typical one** — the median is closer to 130s.

**This changes the deployment picture.** The 870s local budget was adopted
because a 200-result keyword term was believed to take ~289s, comfortably past
Vercel Hobby's 270s. If that is the tail rather than the middle, **Vercel's 270s
clears a 200-result term most of the time** — two of the four measured terms
finished in 56s and 127s. Keyword search is erratic, not uniformly slow.

The practical consequence: localhost is the fallback for a term that stalls, not
a standing requirement for every keyword run. Four runs is a thin basis for a
median and this is worth confirming across more terms — but the Vercel path
should not be written off, and it matters for location+keyword, which multiplies
terms and would otherwise have looked local-only by construction.

## The variant audit, and what it actually found

Before filtering, the full distribution of both country columns was read rather
than sampled — the concern being that the double-writer bug would have produced
`'USA'`/`'US'`, `'UK'` or Spanish-language spellings sitting inside the target
markets, and that a filter would silently drop them.

**It did not.** `country` holds 113 distinct values across 6,026 rows and
contains exactly one variant pair:

    'UAE'                     21 rows
    'United Arab Emirates'    23 rows

Confirmed structurally as well as empirically: of the 49 country names
`detectLocation()` can emit, `'UAE'` is the only one `COUNTRY_ALIASES` would
rewrite. There are no `'USA'`/`'US'`/`'UK'` rows because `detectLocation`'s own
tables already spell those canonically, and no Spanish-language spellings
because both writers emit English names throughout. **The UAE is not in the
target market list, so the filter as specified drops nobody.**

### The city column is where the bug actually bites

The same audit against `city` found the real damage, and it is in the largest
market:

| stored | rows | canonical | rows |
|---|---|---|---|
| `La` | 189 | `Los Angeles` | 262 |
| `Nyc` | 181 | `New York` | 223 |
| `Sf` | 3 | `San Francisco` | 7 |

`TRUNCATED_CITY_MAP` resolves exactly these three. A city filter on
`Los Angeles` today returns 262 of 430 — it misses **42%**. On `New York`, 223
of 398 — **45%**.

No US states, admin regions or descriptive regions appear in the city data, so
the other three rules in `canonicalCity` have nothing to repair. The truncated
forms are the whole of it.

The country scoping on those rules is load-bearing rather than decorative. Of
the 189 `La` rows, 168 are United States and 1 is Mexico — the two countries
`TRUNCATED_CITY_MAP` covers — and **20 are not**: Colombia (7), Spain (3),
France (2), Chile, Nigeria, the UK, Australia, Kenya, South Africa, Sweden and
Japan. Those are the truncated `Lima`s and stray Spanish articles the map's
comment predicts, and rewriting them to `Los Angeles` would be the
unscoped-delete incident in a different verb. The backfill in
docs/migrations/2026-09-02-canonicalise-location-backfill.OPTIONAL.sql carries a
country predicate on every city statement for that reason.

### A methodology note worth keeping

The first pass at this distribution was **wrong**, and the way it was wrong is
reusable. PostgREST `Range` pagination without an `order` clause can skip and
duplicate rows across pages, so the per-value tallies were off — `Nyc` came back
114 in one pass and 116 in another — while the total still summed correctly to
6,026. The error was invisible in the one number being used to sanity-check it.

Re-measured with keyset pagination ordered by `creator_id`, and cross-checked
against `Prefer: count=exact` per value, which does not depend on pagination at
all. **Any bulk read of this database for measurement needs a stable sort, and a
total that matches is not evidence that the breakdown does.**

---

## Recommended sequence

**1. DONE (2026-09-02). Country filter on `get-creators`. No migration.** Add `country` (and
optionally `city`) predicates to the route and a control to the Creators page.
The data is 71% covered, the view already carries the columns, and it makes
4,077 creators queryable — 1,683 of them in-band TikTok. Highest value per unit
of work by a wide margin, and it is the filter every later location source would
have fed anyway.

While in that route: it filters the band on `total_followers`, which is deferred
item 14. The view carries `instagram_followers` and `tiktok_followers`, so
filtering the per-platform column when a platform is selected closes item 14 in
the same change. Measured today the two agree exactly — 3,467 either way — and
creators with both platforms is still **0**, so item 14 remains latent and this
is a correctness fix taken while the file is open, not a bug fix.

**2. DONE (2026-09-02). Fix D1.** `intelligence/analyze` now imports
`canonicalCountry`, `canonicalCity` and `isPlausibleCityCountryPair` and applies
them inside `detectLocation()` — at the point of production rather than the
write site, so a future third writer cannot skip them. On an implausible
city/country pair it drops the CITY and keeps the country, where
`extract-locations` drops both; the reason is recorded in the code: there the
pair comes from one Claude judgement, here from two independent passes, so only
the weaker signal is discarded.

The backfill for rows already written is
docs/migrations/2026-09-02-canonicalise-location-backfill.OPTIONAL.sql —
**written, not applied**, every UPDATE scoped to literal values and preceded by
the SELECT carrying its identical WHERE clause.

D2 (the Spanish-language city gap) is still open and still wants a measurement
before it is widened.

**3. Settle whether the coverage gap is closable** with
`/api/extract-locations?dryRun=true` over a sample — see the section above. This
one costs Claude API calls rather than nothing.

**4. Measure bio location coverage on the ~400 candidates already collected**
before designing any pre-scrape location filter. `author_signature` is populated
for the whole last run, rejects included. If the location markers cover a usable
share, location-from-bio is a free pre-scrape filter on TikTok. If they cover
5%, that is worth knowing before building around it. Same measure-then-decide
move `recordAuthorMetaCoverage` already institutionalises for `fans`.

**5. Only then** decide whether location becomes a discovery-time filter. It is
a filter, not a search source, so it belongs beside the follower band in the
free-filter block of `/api/discover/process` — not as a third `search_source`.

Step 4 is read-only and needs no paid run; step 3 costs a few cents.

### What step 1 shipped

`lib/markets.ts` holds the market list, grouped by language rather than
geography because that is the axis briefs are written on. Adding German-speaking
markets is one uncommented line and nothing else.

The route's `market` parameter takes group names and/or explicit countries.
Absent means no country filter at all — every creator, including the 2,437 with
no country detected; `?market=` with an empty value means every configured
market. Those are different questions and defaulting an absent parameter to "my
markets" would have silently hidden a third of the database from a page that has
always shown all of it.

Countries are matched against **every known spelling**, not just the canonical
one, so the filter is correct whether or not the backfill has been applied.
`market=UAE` and `market=United%20Arab%20Emirates` both return 44 rather than 21
and 23 respectively.

Verified against the dev server, each figure cross-checked against an
independent read-only count:

| query | rows |
|---|---|
| no `market` parameter (unchanged behaviour) | 8,463 |
| `market=english` | 2,433 |
| `market=spanish` | 1,644 |
| `market=english,spanish` | 4,077 |
| `market=english,spanish&platform=tiktok&minFollowers=30000&maxFollowers=500000` | **1,683** |
| `market=englsh` (typo) | 0, with `unknownGroups: ['englsh']` |

A typo'd group name returns zero and says so rather than quietly resolving to
the group it resembles.

---

## The country coverage gap is a detector limit, not a backlog

2,437 creators carry no country. The question was whether detection simply has
not run on them yet — in which case the gap closes for free — or has run and
found nothing. Measured 2026-09-02, read-only, on `social_profiles`:

| | rows |
|---|---|
| profiles total | 8,462 |
| never analysed (`intelligence_updated_at IS NULL`) | **76** |
| `detected_country IS NULL` | 2,410 |
| ...of which never analysed | **76** |
| ...of which **analysed and still null** | **2,334** |

**It is a limitation, not a backlog.** The intelligence pass has run on 8,386 of
8,462 profiles. The 76 it has not touched are exactly the 76 `unknown_size`
creators, which every pipeline queue filters out by design. Every one of the
6,052 profiles that HAS a country was analysed — zero arrived any other way.

It is also not a platform problem. The 2,334 real misses split 1,281 Instagram
to 1,053 TikTok, which against populations of 4,934 and 3,528 is a 26.0% miss
rate on Instagram and 29.8% on TikTok. Close enough that platform is not the
variable.

And it is not missing input: **2,164 of the 2,334 have a bio.** Only 170 have
none. `detectLocation()` read a bio and found no flag, no 📍, no "based in", and
no city from its table — which is the D2 gap in the section above, and the
reason the Spanish-language city coverage is worth widening.

### The recoverable part

**2,332 of the 2,410 have an `ai_summary`**, which is exactly what
`/api/extract-locations` consumes. So the material for a second pass exists for
97% of the gap.

What cannot be told from the data alone is whether `extract-locations` has
already been run over this set and skipped them — it skips below a 0.55
confidence and flags implausible city/country pairs without writing — or has
simply never reached them. Those need different responses and the row does not
record which happened.

**The cheap way to find out** is that route's own `dryRun=true`, which runs the
extraction and reports `extracted`/`skipped`/`flagged_mismatch` per handle
without writing anything. Over a sample of a few dozen it costs a few cents of
Claude API and settles the question. It is an API spend rather than a free
check, so it is the developer's call — but it is the difference between "the
gap is closable for the price of a pass" and "these creators have no location
signal anywhere and the gap is permanent".

---

## Follow-up: seed expansion answered this question, in the negative

**See `docs/seed-expansion-investigation.md` for the measurements. The short
version belongs here, because that document exists to stop this one being
re-read as an open question.**

Following-list traversal was the most promising remaining route to a place-based
source, and it was built as a discovery source — but **not** as a place one:

- Four seeds chosen as Spanish-language, in-band and Bogotá-adjacent produced
  **zero pairwise overlap** (0,0,0,0,0,1 across six pairs). Seeds from the same
  city and language do not share a social neighbourhood.
- **City null 42.3%**, and expansion returned the base rate.
- **Country null 64.7%** by geotag. Like-for-like on the free bio proxy,
  baseline **48.0%** (n=50) against expansion **46.2%** (n=39), **z = −0.17**,
  −1.8 points. Not significant, in the wrong direction.

So seed expansion is a **language** mechanism. It is a cheap, on-market
candidate source — 36.5% in band at $0.0028 per in-band head, better than
keyword on both — and it shipped as a flat fourth `searchSource` with no
promotion and no compounding loop.

**What this does NOT change.** The place columns keep every job this document
gave them. `place_city_code` is still how the database knows which creators are
in New York or Lambeth, and it is still the right filter when a brief names a
city. City failed as a way of **finding more creators**; it did not fail as a
way of **filtering the ones already held**. The market filter, the country
coverage work and D1/D2 above all stand.

A paid 40-creator enrichment test of the country hypothesis was scoped and
deliberately not run: at a 64.7% null, 40 creators yield about 6 place-coded
results, a ±40-point interval, which separates nothing. Two free signals already
agreed. Do not re-propose it.

---

## How each claim here was verified

Working `main` was 27 commits behind `origin/main` at the time of writing, so
every file was read with `git show origin/main:<path>` rather than from the
working tree. Reading the checkout would have described the pre-PR-#7 codebase.

- **Actor capabilities** — each actor's published input schema, fetched twice
  for `searchSection` because the finding contradicted a code comment. The
  documentation turned out to be an incomplete guide to what the actor accepts:
  it lists `"Video"` and the actor also honours the undocumented `/video`. The
  stored run log, not the schema, was what settled it.
- **Fields not read anywhere** — unbounded `git grep` over `origin/main`, exit
  code checked, never a truncated result.
- **All counts** — read-only `SELECT` against the live database via PostgREST,
  aggregate counts only, no rows or personal data retrieved. No writes.
- **`v_creator_summary`'s columns** — read from the live view, because its
  definition is in no tracked migration. Anything asserted about that view from
  the repo alone would have been a guess.
- **Past Apify runs** — stored input records and logs read through the API.
  Reading a completed run starts nothing and costs nothing; no run was started.
- **Not verified:** how much the Claude pass compensates for D2; bio
  location-marker coverage (step 3, pending); whether `searchSection: "Profile"`
  behaves usefully.
