-- ============================================================================
-- OPTIONAL: correct run 328349c2's counters
--
-- No placeholders. Safe to paste whole.
--
-- That run was written before totals were derived from discovery_candidates,
-- so it recorded one term's numbers as the whole run. The candidate log was
-- always right; only the summary was wrong. This recomputes the summary from
-- the log, which is exactly what the finish route now does for new runs.
--
-- total_posts_found is set to 200 rather than derived: two terms at 100 results
-- each. Posts leave no candidate row when they yield no handle, so the log
-- cannot supply that figure — it is the one number still reported by the client.
-- ============================================================================

BEGIN;

UPDATE discovery_runs r
SET total_posts_found        = 200,
    unique_handles_found     = c.total,
    profiles_scraped         = c.scraped,
    creators_in_range        = c.in_range,
    new_creators_added       = c.created,
    existing_creators_updated = c.known
FROM (
  SELECT
    count(*)                                                   AS total,
    count(*) FILTER (WHERE outcome IN (
      'imported_active','imported_archive_high','imported_archive_low',
      'rejected_below_floor','rejected_above_max','unknown_size','scrape_missing'
    ))                                                          AS scraped,
    count(*) FILTER (WHERE outcome = 'imported_active')         AS in_range,
    count(*) FILTER (WHERE outcome IN (
      'imported_active','imported_archive_high','imported_archive_low','unknown_size'
    ))                                                          AS created,
    count(*) FILTER (WHERE outcome = 'already_known')           AS known
  FROM discovery_candidates
  WHERE run_id = '328349c2-b85b-4a10-9023-dbd75792013e'
) c
WHERE r.id = '328349c2-b85b-4a10-9023-dbd75792013e';

COMMIT;

-- Expect: posts 200, handles 154, scraped 150, in range 11, added 19, known 0.
SELECT total_posts_found, unique_handles_found, profiles_scraped,
       creators_in_range, new_creators_added, existing_creators_updated
FROM discovery_runs WHERE id = '328349c2-b85b-4a10-9023-dbd75792013e';
