-- ============================================================================
-- Seed retrievability: telling "expanded" apart from "tried and got nothing"
--
-- No placeholders. Safe to paste whole. Adds three nullable columns and
-- replaces one index. Touches no existing row's data.
--
-- WHY THIS EXISTS — the run that produced it
--
-- 2026-09-05, seed @ramecabrera, Apify run sBO40FJkCliMIu1Xu. The actor
-- SUCCEEDED, exit 0, 66 seconds, and returned an empty dataset. Its log:
--
--   GET https://www.tiktok.com/@ramecabrera__0-__following
--   WARN  Detected broken response from user connections API.   x16, 60s
--   ERROR Request failed and reached maximum retries.
--         Total 2 requests: 1 succeeded, 1 failed
--
-- The PROFILE request succeeded; only the connections endpoint failed. The
-- account is public — we hold its 217 posts, 39k followers, bio and a full
-- enrichment. What is unavailable is the following list specifically, which on
-- TikTok is a separate per-user privacy setting from account privacy.
--
-- Not general flakiness: the four seeds run on 2026-09-04 had ZERO occurrences
-- of that warning across 23 requests, all succeeded.
--
-- WHAT WENT WRONG DOWNSTREAM, and what these columns fix
--
-- seed_expanded_at was written anyway, because the route marked the FETCH
-- rather than the RESULT. The seed was permanently excluded from the queue
-- having yielded nothing, and the run reported as healthy with zero
-- candidates. seed_expanded_at alone cannot express the difference between
--
--   "traversed, here are 200 accounts"      -> never offer again, correctly
--   "traversed, got nothing"                -> do not offer, but not the same
--   "never tried"                           -> offer
--
-- and collapsing the middle case into the first is what burned the seed.
--
-- WHY A NULLABLE BOOLEAN AND NOT A seed_failed_at DATE
--
-- The question the queue asks is "can this list be fetched", which has three
-- answers and one of them is "we do not know". A timestamp column can only say
-- when something happened, so "never tried" and "tried, unretrievable" would
-- again share a representation. NULL / true / false says it directly.
--
-- TRANSIENT VERSUS PERMANENT IS NOT DECIDABLE FROM ONE ATTEMPT, and this
-- schema does not pretend otherwise. false means "one attempt returned nothing
-- against a known non-zero following_count". Setting it back to NULL is how a
-- retry is requested, and it is a deliberate act rather than something a
-- scheduler does — which is the same reasoning that made seed_expanded_at a
-- once-only mark. The note column carries the evidence so that decision can be
-- made by reading rather than by re-running.
-- ============================================================================

BEGIN;

ALTER TABLE social_profiles
  ADD COLUMN IF NOT EXISTS seed_following_retrievable boolean;
ALTER TABLE social_profiles
  ADD COLUMN IF NOT EXISTS seed_last_attempt_at timestamptz;
ALTER TABLE social_profiles
  ADD COLUMN IF NOT EXISTS seed_last_attempt_note text;

COMMENT ON COLUMN social_profiles.seed_following_retrievable IS
  'Whether this profile''s FOLLOWING list could actually be fetched. NULL = never attempted, and the queue offers it. true = an attempt returned items. false = an attempt returned nothing while following_count was non-zero, i.e. the list is hidden by TikTok''s per-user connections privacy setting (distinct from privateAccount, which reads false on such profiles). One attempt cannot distinguish permanent from transient; set this back to NULL to request a retry.';

COMMENT ON COLUMN social_profiles.seed_last_attempt_at IS
  'When a seed traversal was last attempted, successful or not. Distinct from seed_expanded_at, which records only a traversal that RETURNED something.';

COMMENT ON COLUMN social_profiles.seed_last_attempt_note IS
  'Human-readable evidence for the last attempt, e.g. "0 of 383 following returned". Exists so a retry decision can be made by reading rather than by paying to re-run.';

-- The queue index gains the retrievability predicate. Dropped and recreated
-- rather than left beside a second index: the query has one shape and should
-- have one index, and a stale partial index that no longer matches the WHERE
-- clause is not used but is still maintained on every write.
DROP INDEX IF EXISTS social_profiles_seed_queue_idx;

CREATE INDEX IF NOT EXISTS social_profiles_seed_queue_idx
  ON social_profiles (platform, post_language, following_count)
  WHERE seed_expanded_at IS NULL
    AND import_status = 'active'
    AND seed_following_retrievable IS DISTINCT FROM false;

COMMIT;
