#!/bin/bash
# The Quality workflow's laptop-runnable steps, in CI's order, one verdict line per step.
#   run.sh [--web-only|--mobile-only] [--build] [--e2e] [--ci-like] [--out <dir>]
set -u
cd "$(git rev-parse --show-toplevel)" || exit 1
BUILD=0; E2E=0; WEB=1; MOBILE=1; CILIKE=0; OUT="${TMPDIR:-/tmp}/local-checks-$(date +%Y%m%d-%H%M%S)"
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1;; --e2e) E2E=1;; --web-only) MOBILE=0;; --mobile-only) WEB=0;; --ci-like) CILIKE=1;;
    --out) OUT="${2:?--out needs a directory}"; shift;;
    *) echo "unknown flag: $1"; exit 2;;
  esac
  shift
done
mkdir -p "$OUT"; SUMMARY="$OUT/summary.txt"; : > "$SUMMARY"
FAILED=0
say() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
step() {
  local name="$1"; shift
  local log="$OUT/$(printf '%s' "$name" | tr ' /:' '___').log" t0=$SECONDS code
  "$@" > "$log" 2>&1; code=$?
  say "$(printf '%-18s exit %-3s %5ss' "$name" "$code" "$((SECONDS - t0))")"
  if [ "$code" != 0 ]; then
    FAILED=1
    sed $'s/\x1b\\[[0-9;]*m//g' "$log" | grep -vE '^[[:space:]]*$' | tail -40 | sed 's/^/    /' | tee -a "$SUMMARY"
  fi
  return "$code"
}
MOBILE_NM="ugc-mobile/node_modules"; HIDDEN="ugc-mobile/.node_modules-hidden-$$"
restore() { if [ -d "$HIDDEN" ] && [ ! -e "$MOBILE_NM" ]; then mv "$HIDDEN" "$MOBILE_NM"; fi; }
trap restore EXIT
trap 'restore; say "== interrupted"; exit 130' INT TERM HUP
say "== $(git rev-parse --short HEAD) $(git diff HEAD --shortstat | sed 's/^ *//') | $(date '+%Y-%m-%d %H:%M:%S') | logs: $OUT"
if [ "$WEB" = 1 ]; then
  say "-- web job"
  if [ "$CILIKE" = 1 ] && [ -d "$MOBILE_NM" ]; then mv "$MOBILE_NM" "$HIDDEN"; say "   ugc-mobile/node_modules hidden for the web job, as on the CI runner"; fi
  step "test"              npx vitest run --reporter=dot --silent=passed-only
  step "lint"              npm run lint
  step "typecheck"         npm run typecheck
  if [ "$?" != 0 ] && grep -q '\.next/types/' "$OUT/typecheck.log"; then
    say "    hint: .next/types is a stale build artefact naming removed routes; CI has no .next before typecheck. With no next dev running: rm -rf .next/types, then rerun."
  fi
  step "typecheck:scripts" npm run typecheck:scripts
  step "typecheck:tests"   npm run typecheck:tests
  step "perf self-tests"   sh -c 'npm run perf:load:self-test && npm run perf:lighthouse:self-test'
  if [ "$BUILD" = 1 ]; then
    if pgrep -f "next dev" > /dev/null; then say "build              skipped: a next dev is running and shares .next"; FAILED=1
    else step "build" npm run build && step "build:verify" npm run build:verify; fi
  fi
  restore
fi
if [ "$MOBILE" = 1 ]; then
  say "-- mobile job"
  step "mobile test"       sh -c 'cd ugc-mobile && npm test'
  step "mobile typecheck"  sh -c 'cd ugc-mobile && npm run typecheck'
fi
if [ "$E2E" = 1 ]; then
  say "-- e2e smoke"
  if pgrep -f "next dev" > /dev/null; then say "test:e2e           skipped: a next dev is running and Playwright's own server refuses to start"; FAILED=1
  else step "test:e2e" npm run test:e2e; fi
fi
if [ "$FAILED" = 0 ]; then say "== ALL GREEN | $(date '+%H:%M:%S')"; else say "== FAILED | $(date '+%H:%M:%S')"; fi
exit "$FAILED"
