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

## A passing build is not evidence the dev server works

`turbopack.root` was pinned to silence a workspace-root warning, verified with
`npx next build`, and reported as done. `next dev` then failed to resolve
Tailwind, reporting it was searching the developer's home directory. Build and
dev use different resolution paths and share `.next`. Reverted; ledger item 18.

The dev check is the step that keeps getting skipped, and it is the only one
that exercises what a person actually uses.

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
