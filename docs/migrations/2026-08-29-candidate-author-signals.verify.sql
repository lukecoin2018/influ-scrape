-- ============================================================================
-- Verification for 2026-08-29-candidate-author-signals.sql
-- No placeholders. Safe to paste whole.
-- ============================================================================

-- 1. Four new nullable columns. Expect 4 rows, all is_nullable = YES.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'discovery_candidates'
  AND column_name IN ('follower_count_source', 'author_ttseller',
                      'author_signature', 'author_verified')
ORDER BY column_name;

-- 2. The source constraint exists.
SELECT conname FROM pg_constraint
WHERE conrelid = 'discovery_candidates'::regclass
  AND conname = 'discovery_candidates_follower_source_check';

-- 3. Existing rows are untouched: every new column is NULL on all 154.
SELECT count(*)                                              AS total,
       count(*) FILTER (WHERE follower_count_source IS NULL) AS null_source,
       count(*) FILTER (WHERE author_ttseller IS NULL)       AS null_ttseller,
       count(*) FILTER (WHERE author_signature IS NULL)      AS null_signature
FROM discovery_candidates;
