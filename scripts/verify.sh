#!/usr/bin/env bash
#
# The verification sweep. By DEFAULT it checks the committed state at HEAD in a
# throwaway worktree, not the working tree.
#
# WHY THE DEFAULT IS HEAD AND NOT THE WORKING TREE
#
# On 2026-09-03 this script reported "all checks exited 0" for commit 0c0cbd3,
# which then failed on Vercel with a missing export. Both were true: the checks
# passed against the working tree, which contained lib/tiktokAuthorMeta.ts with
# the new function, and the commit did not contain that file because it was
# never staged. The route it committed imported from a module it did not ship.
#
# A green sweep against the working tree says nothing about what you push. It is
# still useful while iterating, so it is kept as --working — but it is no longer
# what you get by accident.
#
# The other two failures this guards, both of which recurred despite being
# written down in docs/verification-rules.md:
#
#   1. `rm -rf .next` while `next dev` runs corrupts the Turbopack cache
#      (deferred-cleanups item 19). This REFUSES to run while a dev server is up.
#   2. Judging a check by grepping its output reported six failing builds as
#      green. Nothing here greps; every step is judged by $?.
#
# Usage:
#   scripts/verify.sh              # HEAD, in a clean worktree     <- default
#   scripts/verify.sh --working    # the working tree, in place
#   scripts/verify.sh --quick      # skip next build (combines with either)
#
# NOT COVERED: the dev-server check. It needs a person to load a page. A script
# that pretended to cover it would recreate the "a passing build means it works"
# error of deferred-cleanups item 18.

set -u -o pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'

MODE=committed
QUICK=no
for arg in "$@"; do
  case "$arg" in
    --working)   MODE=working ;;
    --committed) MODE=committed ;;
    --quick)     QUICK=yes ;;
    *) echo "unknown option: $arg"; exit 2 ;;
  esac
done

# ── Guard 1: never touch .next under a live dev server ───────────────────────
#
# Only applies to --working, which clears and rebuilds .next IN the repo. The
# default committed mode does all its work inside a throwaway worktree with its
# own .next, so a running dev server is irrelevant there — and refusing would
# block the check at exactly the moment it is most wanted, with a server up and
# a commit to confirm. Narrowed after the guard fired on a committed-mode run
# that could not have harmed anything.
if [ "$MODE" = working ] && { pgrep -f "next(-server)? dev" >/dev/null 2>&1 || pgrep -f "next dev" >/dev/null 2>&1; }; then
  echo "${RED}REFUSING TO RUN: a Next dev server is running.${OFF}"
  echo
  echo "Clearing .next underneath a live dev server corrupts the Turbopack cache"
  echo "and produces module-resolution failures that get misattributed to whatever"
  echo "changed most recently. See docs/deferred-cleanups.md #19."
  echo
  pgrep -fl "next.* dev" 2>/dev/null | sed 's/^/  /'
  echo
  echo "Stop it first, or:  ${YEL}pkill -f 'next dev'${OFF}"
  exit 2
fi

# ── Report the gap between HEAD and the working tree, always ─────────────────
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then
  echo "${YEL}Working tree differs from HEAD:${OFF}"
  echo "$DIRTY" | sed 's/^/  /'
  echo
fi

WT=""
cleanup() {
  if [ -n "$WT" ] && [ -d "$WT" ]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  fi
}
trap cleanup EXIT

if [ "$MODE" = committed ]; then
  HEAD_SHA="$(git rev-parse --short HEAD)"
  echo "Checking ${GRN}HEAD ($HEAD_SHA)${OFF} in a clean worktree ${DIM}— not the working tree${OFF}"
  if pgrep -f "next dev" >/dev/null 2>&1; then
    echo "${DIM}  (a dev server is running; it is untouched — this runs in its own worktree)${OFF}"
  fi
  [ -n "$DIRTY" ] && echo "${DIM}  (the changes listed above are NOT part of this check)${OFF}"
  echo
  WT="$(mktemp -d "${TMPDIR:-/tmp}/verify-head-XXXXXX")"
  rm -rf "$WT"
  git worktree add --detach "$WT" HEAD >/dev/null 2>&1 || { echo "${RED}worktree add failed${OFF}"; exit 2; }
  # node_modules must be a REAL directory: Turbopack rejects a symlink with
  # "Symlink node_modules is invalid, it points out of the filesystem root"
  # (verification-rules.md, "Verifying a range of commits"). An APFS clone copy
  # is a real directory and takes ~3s for 438M.
  cp -Rc "$REPO/node_modules" "$WT/node_modules" 2>/dev/null \
    || cp -R "$REPO/node_modules" "$WT/node_modules"
  # A faithful build needs the env file. It lives only in this temp worktree and
  # is removed with it on exit.
  [ -f "$REPO/.env.local" ] && cp "$REPO/.env.local" "$WT/.env.local"
  RUNDIR="$WT"
else
  echo "${YEL}Checking the WORKING TREE, not HEAD.${OFF}"
  echo "${DIM}  A pass here says nothing about what you would push. Use the default${OFF}"
  echo "${DIM}  (no flag) before committing or pushing.${OFF}"
  echo
  RUNDIR="$REPO"
fi

FAILED=()
step() {
  local name="$1"; shift
  ( cd "$RUNDIR" && rm -rf .next tsconfig.tsbuildinfo )   # cleared before EACH step
  printf '%-14s ' "$name"
  if ( cd "$RUNDIR" && "$@" ) >"/tmp/verify-$name.log" 2>&1; then
    echo "${GRN}exit=0${OFF}"
  else
    local code=$?
    echo "${RED}exit=$code${OFF}   ${DIM}(log: /tmp/verify-$name.log)${OFF}"
    FAILED+=("$name")
  fi
}

step test  npm test
step tsc   npx tsc --noEmit
[ "$QUICK" = yes ] || step build npx next build

( cd "$RUNDIR" && rm -rf .next tsconfig.tsbuildinfo )

echo
if [ ${#FAILED[@]} -ne 0 ]; then
  echo "${RED}FAILED: ${FAILED[*]}${OFF}"
  exit 1
fi

if [ "$MODE" = committed ]; then
  echo "${GRN}All checks exited 0 against HEAD ($(git rev-parse --short HEAD)).${OFF}"
else
  echo "${GRN}All checks exited 0 against the WORKING TREE.${OFF}"
  echo "${YEL}This does not describe any commit.${OFF}"
fi
echo
echo "${YEL}Not covered:${OFF} the dev-server check. A passing build is not evidence"
echo "the dev server works — they use different resolution paths. Start dev and"
echo "load the affected page before calling a change verified."
