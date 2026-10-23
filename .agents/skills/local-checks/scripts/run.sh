#!/bin/bash
# The Quality workflow's laptop-runnable steps, in CI's order, one verdict line per step.
#   run.sh [--web-only|--mobile-only] [--build] [--e2e] [--ci-like] [--out <dir>]
set -u
# It checks the checkout it sits in, and starts only from inside that checkout. Outside any checkout
# `git rev-parse` prints nothing and `cd ""` stays put, so a run from the folder above the repo ran vitest there
# (2026-10-23); from another checkout it would check that one, with this copy's steps. A git hook's GIT_DIR
# would make --show-toplevel answer the folder it is asked from.
unset GIT_DIR GIT_WORK_TREE
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)"
HERE="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ] || [ "$HERE" != "$ROOT" ]; then
  if [ -z "$HERE" ]; then
    echo "run.sh: refused, nothing run: $PWD is in no git checkout. Start the copy in the checkout to check from inside it:" >&2
    echo "  (cd \"${ROOT:-<checkout>}\" && .agents/skills/local-checks/scripts/run.sh $*)" >&2
  else
    echo "run.sh: refused, nothing run: this copy checks ${ROOT:-no checkout}, and the current directory is in $HERE. Start the copy in the checkout to check from inside it:" >&2
    echo "  (cd \"$HERE\" && .agents/skills/local-checks/scripts/run.sh $*)   # the current directory's checkout" >&2
    if [ -n "$ROOT" ]; then echo "  (cd \"$ROOT\" && .agents/skills/local-checks/scripts/run.sh $*)   # this copy's checkout" >&2; fi
  fi
  exit 2
fi
cd "$ROOT" || exit 1
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
# The build pair runs as on CI's runner, from any checkout: with the env of quality.yml's Build step, read from
# the workflow (build:verify, CI's next step, sets none and reads none), and with none of the app's other
# variables (those .env.example lists, the E2E bypass flags, and NODE_ENV, which `next build` keeps if it
# inherits one) or .env files. A worktree has no .env.local, so without the step's placeholders prerendering
# fails ("supabaseUrl is required"); the primary checkout's can point at production, and `next build` runs the
# app's server code to prerender. The .env guard is the E2E server's, in every node process of the build through
# NODE_OPTIONS, which holds it alone, quoted as a checkout's path can hold a space. CI's runner sets none; Next
# rebuilds it for the build's workers and glues a `--require <file>` given before the guard onto the guard's
# path; and npm replaces it with an npm `node-options` setting unless that says the same.
CI_BUILD_ENV=()
read_ci_build_env() {
  local pair
  while IFS= read -r pair; do CI_BUILD_ENV+=("$pair"); done < <(awk -v sq="'" '
    /^ *- name: / { build = ($0 ~ /- name: Build *$/); next }
    build && /^ *env: *$/ { inenv = 1; next }
    inenv && /^ +[A-Z][A-Z0-9_]*: / {
      sub(/^ +/, ""); i = index($0, ": "); value = substr($0, i + 2); q = substr(value, 1, 1)
      if ((q == "\"" || q == sq) && length(value) > 1 && substr(value, length(value)) == q) value = substr(value, 2, length(value) - 2)
      print substr($0, 1, i - 1) "=" value; next
    }
    inenv { exit }
  ' .github/workflows/quality.yml 2>/dev/null)
  [ "${#CI_BUILD_ENV[@]}" -gt 0 ]
}
ci_build() (
  for name in NODE_ENV E2E_AUTH_BYPASS NEXT_PUBLIC_E2E_AUTH_BYPASS NPM_CONFIG_NODE_OPTIONS \
    $(sed -n 's/^#\{0,1\} \{0,1\}\([A-Z][A-Z0-9_]*\)=.*/\1/p' .env.example); do unset "$name"; done
  for pair in "${CI_BUILD_ENV[@]}"; do export "$pair"; done
  export NODE_OPTIONS="--require=\"$ROOT/tests/e2e/support/no-env-files.cjs\""
  export npm_config_node_options="$NODE_OPTIONS"
  exec "$@"
)
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
    elif ! read_ci_build_env; then say "build              refused: no env read from the Build step of .github/workflows/quality.yml"; FAILED=1
    else
      # CI's checkout has no .next, and earlier builds keep unstable_cache entries here under keys that do not
      # name the project (a build of the primary checkout may have read production).
      rm -rf .next/cache/fetch-cache
      step "build" ci_build npm run build && step "build:verify" ci_build npm run build:verify
    fi
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
  # playwright.config.ts gives the run its whole env, so the shell's does not matter. Next allows one
  # next dev per checkout: its server process holds .next/dev/lock while it runs, so only a holder here
  # stops Playwright's own server (one of another worktree has a .next of its own), which also needs
  # port 3100 free.
  lock="$(lsof -t .next/dev/lock 2>/dev/null | head -1)"
  port="$(lsof -nP -iTCP:3100 -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$lock" ]; then say "test:e2e           skipped: a next dev of this checkout holds .next/dev/lock (pid $lock); stop it, then run npm run test:e2e"; FAILED=1
  elif [ -n "$port" ]; then say "test:e2e           skipped: port 3100 is taken (pid $port, in $(lsof -a -p "$port" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')); once it is free, run npm run test:e2e"; FAILED=1
  else step "test:e2e" npm run test:e2e; fi
fi
if [ "$FAILED" = 0 ]; then say "== ALL GREEN | $(date '+%H:%M:%S')"; else say "== FAILED | $(date '+%H:%M:%S')"; fi
exit "$FAILED"
