# Verification rules

A process rule, not deferred work. The ledger tracks what is left undone; this
is how work is confirmed done in the first place.

## The rule

**Every check is judged by its exit code. Never by matching its output.**

A grep over stdout can only catch the failures it was written to anticipate.
`next build` printed `✓ Compiled successfully` and then exited 1.

```bash
rm -rf .next tsconfig.tsbuildinfo && npm test          ; echo "tests exit=$?"
rm -rf .next tsconfig.tsbuildinfo && npx tsc --noEmit  ; echo "tsc   exit=$?"
rm -rf .next tsconfig.tsbuildinfo && npx next build    ; echo "build exit=$?"
rm -rf .next tsconfig.tsbuildinfo && npm run dev
```

All three exit 0, **and** the dev server serves the affected page in a browser.
Reading output is for diagnosing a failure the exit code has already declared —
never for deciding whether one occurred.

## Why output matching fails

`next build` runs in phases. It prints `✓ Compiled successfully` after bundling,
then continues to TypeScript and page-data collection, either of which can fail
afterwards:

    ✓ Compiled successfully in 910.6ms
      Running TypeScript ...
      Collecting page data using 11 workers ...
    ⨯ Invalid segment configuration export detected.

Builds here were checked with `grep -E "Compiled|Failed"`. That last line
contains neither word, so the grep matched only the success line above it.
**Six commits were reported as building and exited 1** — caused by
`export const maxDuration = SOME_CONST`, which Next rejects because it
statically analyses segment config exports and requires a literal.

The same failure mode applies to every tool here. Match nothing; read `$?`.

## The class: a check that passes while measuring the wrong thing

The `Compiled` grep is not a one-off. It is the founding instance of the failure
mode that has cost the most time on this project, and it is worth naming as a
class so the next one is recognised as a member rather than rediscovered.

**A check that passes is evidence only about the thing it actually measured.
When what it measures has drifted from what you believe it measures, it goes on
passing, and its passing is what stops anyone looking.** A failing check is
loud. A check that is green about the wrong subject is silent, and silence is
indistinguishable from correctness until something downstream breaks.

Every instance so far, with what each was really measuring:

| Believed to check | Actually measured | How it surfaced |
|---|---|---|
| The build succeeded | That the word `Compiled` appeared in stdout | Six commits reported green, all exit 1 |
| The field is read | That an accessor was written — `displayName`, `profileImage`, `taggedAccounts` never existed | `full_name` populated on 1 of 3,458 creators |
| The commit is sound | The working tree, which contained an unstaged file the commit did not | `0c0cbd3` failed on Vercel, missing export |
| The tallies are right | Totals, which matched, over unordered pagination that skipped and duplicated rows | Per-value counts off by two, `Nyc` 114 against 116 |
| `searchResultPrice` is correct | That the helper is correct — nothing asserted it is CALLED | Keyword runs quoted 15x high for weeks |
| Seed expansion is cheaper | A comparison against a price the estimate was computing wrongly | The test went RED when the pricing bug was fixed |

The last two are the same event and the most instructive pair, because the
second was a **unit test that had to be inverted**. `lib/seedExpansion.test.ts`
asserted `seed.hashtagUsd < keyword.hashtagUsd` — "the following list is the
cheaper fetch" — and passed, green, from the day it was written. It passed only
because `estimateDiscoveryCost` was quoting TikTok keyword search at the
clockworks rate instead of xmolodtsov's. The following actor is four times
*dearer* per result, not cheaper.

So the test was not failing to catch the bug. **It was asserting it.** And
because a test is the thing you point at to show a claim is checked, the wrong
comparison propagated out of the pricing module and into
`docs/seed-expansion-investigation.md`, where seed expansion was described as
the cheapest candidate source in the pipeline — a sentence a spend decision
would have been made from. A mispriced constant does not stay in the file that
holds it.

### What actually catches this class

Not more checks. Checks of a different kind:

- **Assert on the caller, not only on the helper.** Four assertions proved
  `searchResultPrice` returned the right number. None proved anything used it.
  The three added to `discoveryCost.test.ts` assert on the *estimate*, which is
  what a person reads.
- **A green check must name its subject.** `scripts/verify.sh` prints
  `HEAD (sha)` or `the WORKING TREE — this does not describe any commit`,
  because the earlier version printed neither and the reader supplied the
  flattering assumption.
- **Prefer the exit code, the row count, the constraint** — signals produced by
  the system rather than interpreted from its output.
- **Treat a green test that has never gone red as unverified.** A test written
  alongside the code it tests, passing from the first run, has not yet
  demonstrated it can fail. When a change makes such a test fail, the first
  question is whether the test was right — not how to make it pass again.
- **When a number appears in prose, trace it back to what computed it.** Both
  documented claims that turned out wrong were numbers copied from a passing
  computation into a sentence.


## A passing build is not evidence the dev server works

`turbopack.root` was pinned to silence a workspace-root warning, verified with
`npx next build`, and reported as done. `next dev` then failed to resolve
Tailwind, reporting it was searching the developer's home directory. Build and
dev use different resolution paths and share `.next`. Reverted; ledger item 18.

The dev check is the step that keeps getting skipped, and it is the only one
that exercises what a person actually uses.

## Run the sweep through `scripts/verify.sh`

The two rules below — clear `.next` before each check, judge by exit code — were
both written down here and both broken anyway. The `.next`-with-a-running-server
one happened three times across two sessions.

`scripts/verify.sh` enforces them instead of asking:

```bash
scripts/verify.sh          # test + tsc + build
scripts/verify.sh --quick  # test + tsc
```

It refuses to run while a Next dev server is up (exit 2, deletes nothing),
clears `.next` before each step, and judges every step by `$?`. The dev-server
check is still yours to do by hand — see the section below on why a passing
build is not evidence of it. The rules below remain the explanation of WHY;
the script is what makes following them the default.

## Clear `.next` before every check, not just between modes

`.next` state has produced misleading results repeatedly, in more than one way:

1. **Mixed production and dev artifacts.** `next build` and `next dev` share the
   directory. Building and then starting dev without clearing left production
   `server/` and `static/` beside a dev `turbopack/` cache, producing
   module-resolution failures that looked like whatever config had changed most
   recently (ledger item 19).

2. **Stale generated route types.** `tsconfig.json` includes
   `.next/types/**/*.ts`, which are generated per build. Checking out an older
   commit while those types describe a newer commit's routes makes `tsc` report
   phantom errors for routes that commit does not contain. One commit was
   recorded as failing typecheck for exactly this reason and passes cleanly on
   an empty `.next`.

3. **A running dev server writing during a sweep.** A per-commit verification
   run was contaminated by a `next dev` left running against the same directory;
   one `rm -rf .next` failed mid-sweep with "Directory not empty". Stop every
   server before verifying, and re-run rather than trusting the results.

So: `rm -rf .next tsconfig.tsbuildinfo` before **each** check, not once at the
start — and no dev server running while a sweep is in progress.

## A shell that silently rewrites your query

**In zsh, `"$ref:path"` is not what you wrote.** `:l` is a history-style
modifier meaning "lowercase", so zsh consumes it:

```bash
b=keyword-search-actor
git show "$b:lib/apify.ts"      # -> fatal: ambiguous argument
                                #    'keyword-search-actorib/apify.ts'
git show "${b}:lib/apify.ts"    # correct
```

With `2>/dev/null` on the end — which every loop over refs has — the error
vanishes and the command substitution returns empty. A `grep -c` over that
empty output returns 0, and a containment check built on it reports **"this
branch does not contain the change"** for a branch that plainly does.

That happened three times in a row on 2026-09-03 while establishing which
branch carried a shipped actor switch, and each wrong answer was reported as
fact. The direct, un-looped command had been run minutes earlier and showed the
opposite.

**Two rules:**

1. **Always brace a ref used with a path: `"${ref}:path"`.** The other modifiers
   (`:h`, `:t`, `:r`, `:e`, `:u`, `:s`) are the same hazard on any path
   beginning with those letters — `${b}:head/...`, `${b}:test/...`,
   `${b}:refs/...` all misparse unbraced.
2. **When a loop produces a surprising negative, run one case directly before
   believing it.** "Branch X does not contain the commit I just wrote" is
   surprising. One `git show` outside the loop settles it in seconds, and it is
   the same instinct as reading `$?` instead of grepping output: the cheap
   direct check beats the convenient indirect one.

This is the same failure class as the `grep -E "Compiled|Failed"` build check
and the truncated-grep rule. **A check that cannot fail loudly will eventually
report the wrong thing and be believed.** Prefer checks that error rather than
return empty: dropping `2>/dev/null` would have surfaced this immediately.

## Verifying a range of commits

Check out each commit in the working directory and run all three, clearing
`.next` before each. A `git worktree` with a **symlinked** `node_modules` does
not work: Turbopack rejects it with `Symlink node_modules is invalid, it points
out of the filesystem root`. `tsc` and `npm test` run fine there — only the
build does not, which is exactly the check that was missed.

## After rewriting history

If commits are amended or rebuilt, diff the new tip against the pre-rewrite tip
and confirm the change set is precisely what was intended and nothing else. That
check caught a `package.json` left at its first-commit state across seven
commits during one rewrite, which would have broken `npm test` from the fourth
onward while every commit still looked green.

## Deletions in migrations

**Every DELETE must be scoped to an explicit list of ids, and every DELETE must
be preceded in the same file by a SELECT carrying the identical WHERE clause.**

The reader runs the SELECT, sees exactly which rows match, and only then runs
the DELETE. A file that does not let them do that is not reviewable.

### The failure mode: a subquery that reads as scoped and is not

This was written, reviewed, shipped and applied:

```sql
DELETE FROM social_profiles WHERE handle IN ( ...eleven handles... );

DELETE FROM creators c
WHERE NOT EXISTS (SELECT 1 FROM social_profiles sp        WHERE sp.creator_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM social_profiles_archive sp WHERE sp.creator_id = c.id);
```

The first statement is scoped. The second reads as "and now the creators those
eleven left behind" and means "**every orphaned creator in the table**". There
were roughly 121 pre-existing orphans. It deleted all of them — 120 from
`creators`, 1 from `creators_archive` — when 11 and 4 were intended.

The comment above it said "Then creators with no profile left beneath them",
which describes the intent and not the statement. Prose cannot scope a query.

### "I measured what it touched" means the statement was run as a SELECT

It does not mean the intended target was counted. In the case above, eleven
creator rows were listed, their foreign-key references checked, and the result
reported as a complete impact assessment. What was never done was running the
DELETE's own WHERE clause as a SELECT — which would have returned 121 rows and
stopped the whole thing.

Worse, the impact assessment checked three tables — `creator_posts`,
`partnerships`, `creators` — when thirteen carry `creator_id`, including
`negotiations`, `contracts`, `inquiries`, `shortlist_items`, `rate_calculations`
and `creator_outreach`. Those turned out to be empty or unaffected, but that was
luck, not diligence.

**Before writing any DELETE, enumerate every table referencing the target**, by
reading the schema rather than by recalling which ones came up earlier:

```sql
SELECT tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu   ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = '<target table>';
```

### Required shape

```sql
-- 1. SELECT with the exact WHERE clause of the DELETE below. Run this first.
SELECT id, handle FROM creators WHERE id IN ('...', '...');

-- 2. The DELETE, same WHERE clause, explicit ids only.
DELETE FROM creators WHERE id IN ('...', '...');
```

No `NOT EXISTS`, no `NOT IN` over a whole table, no correlated subquery deciding
scope. If the id list has to be computed, compute it with a SELECT, paste the
result in, and delete by literal id.
