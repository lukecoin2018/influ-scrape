# Incident: unscoped DELETE removed 132 creator rows

**What:** `docs/migrations/2026-08-29-remove-c8-imports.OPTIONAL.sql` and
`2026-08-29-remove-discovery-archive-rows.OPTIONAL.sql` each ended with an
unscoped `DELETE FROM creators*`. Applied on 2026-08-29, they removed **132**
creator rows when **15** were intended.

**Written by Claude, applied by the developer on the strength of a stated impact
assessment that had not tested the statement that caused the damage.**

## The statement

```sql
DELETE FROM creators c
WHERE NOT EXISTS (SELECT 1 FROM social_profiles sp        WHERE sp.creator_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM social_profiles_archive sp WHERE sp.creator_id = c.id);
```

Intended: the creators orphaned by the eleven profiles deleted immediately above.
Actual: every orphaned creator in the table.

## Measured impact

| table | expected | actual | delta |
|---|---|---|---|
| creators | 7,255 | 7,135 | **−120** |
| creators_archive | 1,497 | 1,496 | **−1** |
| social_profiles | 7,135 | 7,135 | ok |
| social_profiles_archive | 1,496 | 1,496 | ok |

The scoped statements were correct. Only the orphan cleanups over-reached.

`creator_registry` was not touched and retains one row per creator ever seen, so
the lost ids are recoverable as a list: 132 registry rows point at creators that
no longer exist — 127 `active`, 5 `below_min`, first seen between 2026-02-13 and
2026-08-29.

**No dangling references anywhere.** All thirteen tables carrying `creator_id`
were checked afterwards — `partnerships`, `negotiations`, `contracts`,
`inquiries`, `shortlist_items`, `rate_calculations`, `creator_outreach`,
`funnel_events`, `creator_profiles` and the rest — and none held a row pointing
at a deleted creator. `activity_log` likewise. The deleted rows were isolated:
no profiles, no partnerships, no business records.

What was lost is whatever those 132 `creators` rows held directly — display
name, full name, bio, `content_tags`, `is_featured`, `notes`, embeddings,
country, contact email. There is no trace of those values anywhere.

## How it got through

1. **The impact assessment measured the wrong thing.** Eleven creator rows were
   listed, their references checked, and the result reported as complete. The
   DELETE's own WHERE clause was never run as a SELECT. Doing so would have
   returned 132 rows.
2. **A prose comment was treated as scope.** "Then creators with no profile left
   beneath them" describes the intent; the SQL says something else.
3. **Only three referencing tables were checked** — `creator_posts`,
   `partnerships`, `creators` — when thirteen carry `creator_id`. The others
   were empty or unaffected, which was luck.
4. **The file was labelled OPTIONAL and low-risk**, which framed the review as a
   formality.

## Rules added

See `docs/verification-rules.md`, section "Deletions in migrations":

- Every DELETE is scoped to explicit ids. No `NOT EXISTS`, `NOT IN` over a whole
  table, or correlated subquery deciding scope.
- Every DELETE is preceded in the same file by a SELECT with the identical WHERE
  clause.
- "I measured what it touched" means the statement was run as a SELECT, not that
  the intended target was counted.
- Enumerate referencing tables from the schema, not from memory.
