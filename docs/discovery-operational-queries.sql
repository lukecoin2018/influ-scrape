-- ############################################################################
-- ##                                                                        ##
-- ##  DO NOT PASTE THIS FILE WHOLE.                                         ##
-- ##                                                                        ##
-- ##  It contains placeholders. Copy ONE query at a time, replace every     ##
-- ##  placeholder marked REPLACE below it, then run.                        ##
-- ##                                                                        ##
-- ##  The convention, so this cannot recur:                                 ##
-- ##    - A file meant to be pasted whole contains no placeholders.         ##
-- ##    - A file containing placeholders is never paste-whole.              ##
-- ##                                                                        ##
-- ############################################################################


-- ============================================================================
-- Abandoned runs
--
-- REPLACE: nothing. This one is runnable as-is.
--
-- Runs still marked 'running' that have been silent longer than a live run
-- plausibly could be. Nothing sweeps these — the state is derived on read so
-- the record stays honest about what was last observed. A sweep would rewrite
-- history on a guessed threshold, and a row rewritten to 'cancelled' could no
-- longer be told apart from one the user actually stopped.
--
-- Widen the interval if a legitimate long run ever trips it.
-- ============================================================================

SELECT id, hashtags, platform, started_at, last_progress_at,
       now() - coalesce(last_progress_at, started_at) AS silent_for
FROM discovery_runs
WHERE status = 'running'
  AND coalesce(last_progress_at, started_at) < now() - interval '2 hours'
ORDER BY started_at DESC;


-- ============================================================================
-- The R3 funnel: already-known versus genuinely out of band, per search term
--
-- REPLACE: 'PUT_RUN_ID_HERE' with the run's uuid, quoted.
--          Get it from the Discovery Progress panel, or from:
--            SELECT id, hashtags, started_at FROM discovery_runs
--            ORDER BY started_at DESC LIMIT 5;
-- ============================================================================

SELECT hashtag,
       count(*)                                                 AS candidates,
       count(*) FILTER (WHERE outcome = 'entity_excluded')      AS entity_excluded,
       count(*) FILTER (WHERE outcome = 'already_known')        AS already_known,
       count(*) FILTER (WHERE outcome = 'cached_reject')        AS cached_reject,
       count(*) FILTER (WHERE outcome = 'scrape_missing')       AS scrape_missing,
       count(*) FILTER (WHERE outcome LIKE 'imported%')         AS imported,
       count(*) FILTER (WHERE outcome = 'rejected_below_floor') AS below_floor,
       count(*) FILTER (WHERE outcome = 'unknown_size')         AS unknown_size,
       count(*) FILTER (WHERE outcome = 'not_scraped')          AS not_scraped
FROM discovery_candidates
WHERE run_id = 'PUT_RUN_ID_HERE'
GROUP BY hashtag
ORDER BY hashtag;


-- ============================================================================
-- The stamping-floor distribution, from Discovery's own data
--
-- REPLACE: 'PUT_RUN_ID_HERE' with the run's uuid, quoted.
--
-- This is what sets NEAR_MISS_FLOOR. It replaces the brand-feed archive proxy,
-- which is biased upward — brand-feed candidates were selected by a brand,
-- hashtag candidates were not.
-- ============================================================================

SELECT
  CASE
    WHEN follower_count IS NULL   THEN 'z. never measured'
    WHEN follower_count <  5000   THEN 'a. <5k'
    WHEN follower_count < 15000   THEN 'b. 5k-15k'
    WHEN follower_count < 30000   THEN 'c. 15k-30k'
    WHEN follower_count <= 500000 THEN 'd. in band'
    ELSE 'e. >500k'
  END AS bucket,
  outcome,
  count(*) AS n
FROM discovery_candidates
WHERE run_id = 'PUT_RUN_ID_HERE'
GROUP BY 1, 2
ORDER BY 1, 2;


-- ============================================================================
-- Stranded handles after the near-miss floor is LOWERED
--
-- REPLACE: 15000 with the NEW floor value.
--
-- Lowering the floor does not re-admit handles already cached between the old
-- and new values: the dedupe check compares against minFollowers, not the
-- floor, so they stay rejected until their TTL lapses. Only the follower count
-- was kept, so re-admitting them needs a fresh scrape. This lists them with
-- counts so the cost is visible before deciding.
-- ============================================================================

SELECT DISTINCT platform, handle, follower_count
FROM discovery_candidates
WHERE outcome = 'rejected_below_floor'
  AND follower_count >= 15000
ORDER BY follower_count DESC;
