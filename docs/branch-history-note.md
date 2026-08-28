# Note on this branch's history

`discovery-conversion` carries ten commits converting the Discovery page to the
import path the brand-feed build established.

**The history is reconstructed, not recorded.** All ten changes were made in a
single working tree over one session and committed afterwards, by rebuilding
each step's file state and committing forward. Eleven files carry edits from
more than one step — `lib/profileImportCore.ts` alone spans three — so the
commit boundaries are an honest description of what changed and why, but they
are not a record of the order in which the edits were typed. Every commit was
checked out in an isolated worktree and verified to compile and pass its own
tests (9 → 28 → 28 → 45 → 61 → 61 → 72 → 89 → 107 → 107).

The reconstruction introduced two errors, both caught by diffing the final tree
against a backup taken before any git operation: `package.json` was left at its
first-commit state in seven commits, which would have broken `npm test` from the
fourth commit onward, and a stray blank line survived in `lib/followerRange.ts`.
Both were repaired with `git filter-branch` over the range, guarded so the test
runner's resolver hook is only added to commits that actually contain it. SHAs
from the fourth commit onward were rewritten as a result.

Recorded here because `git log` cannot say any of this, and the branch outlives
the conversation that produced it.
