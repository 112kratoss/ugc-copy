---
name: local-checks
description: Run this repo's CI-equivalent local gate before opening or merging a PR: the Quality workflow's web and mobile steps in CI's order, with a one-line verdict per step and only the failing output shown. Use when asked to "run the checks", "make sure it's green", or before a merge; add --build for the production build, --e2e for the Playwright smoke, --ci-like to hide ugc-mobile/node_modules as the CI runner has none.
---

# Local checks

```bash
.agents/skills/local-checks/scripts/run.sh
```

Flags: `--web-only`, `--mobile-only`, `--build` (production build and `build:verify`), `--e2e` (Playwright smoke), `--ci-like` (hides `ugc-mobile/node_modules` for the web job and restores it after, because a root test that reaches into the app's packages passes here and fails on the runner), `--out <dir>` (logs; default under `$TMPDIR`).

What it runs, in the order of `.github/workflows/quality.yml`: web `vitest run --reporter=dot --silent=passed-only` (the same suite as `npm test`, output only from failing tests), `lint`, `typecheck`, `typecheck:scripts`, `typecheck:tests`, the perf self-tests, then with `--build` the build pair; mobile `npm test` and `npm run typecheck` in `ugc-mobile`; with `--e2e`, `npm run test:e2e`.

It prints one line per step (`name exit code seconds`) and, for a failing step, the last forty lines of its log; full logs sit in the out dir. The exit code is 0 only when every step passed. Read the summary, not the logs, unless a step failed.

Not covered, because they need the local Supabase stack or CI's images: the Supabase API integration job and the migration replay (`npx supabase db reset --local` and `npx supabase test db` with Docker up), the four FFmpeg audits, and the mobile `expo install --check`, `expo-doctor`, `prebuild` and `export` steps.

A `typecheck` failure that names only `.next/types/validator.ts` is a stale build artefact listing routes since removed; CI never sees it because it has no `.next` before typecheck. With no `next dev` running, `rm -rf .next/types` and rerun (the script prints this hint when it applies).

Before running: `--build` and `--e2e` refuse to run while a `next dev` is listening (they share `.next`, and Playwright's own server refuses to start), so stop any preview server first. If the mobile suite times out on a busy Mac, stop the emulator and rerun `--mobile-only`.
