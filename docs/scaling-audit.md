# Current Scaling Assessment

Last reviewed: 2026-08-22
Reviewed base commit: `0345d786ffb86a44c5cc997414997a073f1ace6b`
Fix state: **current working tree; publish a commit hash after merge**
Status: **NOT CERTIFIED for a current MAU or sustained-RPS claim**

This is the active entry point for scaling decisions. It is intentionally
short. Detailed source evidence and acceptance criteria are in
[`scaling-findings-2026-08-22.md`](scaling-findings-2026-08-22.md). Historical
investigation is preserved under [`archive/`](archive/), and exact-build
capacity reports are indexed under [`scaling-certificates/`](scaling-certificates/).

## Executive verdict

The application is materially better protected than it was before the August
scaling work: feed playback uses bounded renditions/teasers, ranked pagination
keeps its cursor, feed telemetry is batched, provider work has durable admission
and settlement, heavy media jobs are isolated, and feed retention is bounded.
The full web and mobile suites pass on the remediated working tree.

However, the old 2,026/4,559 authenticated-web MAU scenarios must not be used as
current capacity. They came from a scoped certificate for `c1d494e`; the reviewed
base was 83 commits and 569 changed files later.

The fresh audit's actionable source findings now have implementations:

1. Authenticated route admission is passed from the proxy in a short-lived HMAC
   assertion bound to bearer token, method and path. Route Auth/lifecycle helpers
   verify and reuse it, while direct/rolling calls retain the fail-closed database
   fallback. Proxy time is included in certification timing.
2. Upload byte admission uses transactionally maintained per-user and singleton
   counters instead of reservation sums/global advisory locking. Reclaim has
   independent scan, action and wall-clock ceilings, defers protected rows, and
   exports backlog/counter health.
3. Public feed/detail/comments reads retain PostgreSQL admission as a deliberate
   no-extra-service constraint whose write cost must be included in the next
   certificate. Durable tables are included in growth accounting, merge tickets
   have bounded retention, and the compact catalog v3 response is 56,106 bytes
   locally versus the 57,344-byte budget while v1/v2 remain compatible.

These are source fixes, not a capacity certificate. The two new migrations now
replay cleanly against a disposable local Supabase database and the full pgTAP
suite passes. Local 10k/100k/1m database fixtures now verify bounded upload
admission and PostgreSQL rate-limit behavior, but exclude Auth, PostgREST,
Storage, CDN, Vercel and network costs. The identity assertion secret is now
configured for Production, but it does not affect an already-built deployment;
no current deployed isolated mixed-workload run has measured the repaired paths.

## What can be claimed today

| Claim | Current status |
|---|---|
| Public cached pages and recent-feed reads are guarded by production budgets | **Monitored, but the workflow is not green** |
| S1-S3/S7-S8 source remediations | **Implemented; tests/build green, deployment/load evidence pending** |
| S2 local database admission at 10k/100k/1m rows | **Passed; 50 concurrent × 5 rounds per tier, zero drift/failures** |
| S6 no-subscription public-read limiter decision | **Local database cost measured; deployed origin write budget still required** |
| Catalog v3 decoded body on the local current projection | **56,106 bytes; under 57,344-byte budget** |
| Current authenticated origin capacity | **Not certified** |
| Current upload-sign/finalize capacity | **Not certified** |
| Current mobile capacity | **Not certified** |
| Current anonymous multi-source capacity | **Not certified** |
| Current full-app MAU ceiling | **No valid number** |

The historical result remains useful as proof that the old build sustained its
declared workload. It is not a lower bound for the current build: later work can
improve one path and regress another. See
[`2026-08-10-c1d494e.md`](scaling-certificates/2026-08-10-c1d494e.md).

## Priority board

| ID | Finding | Severity | Status | Required outcome |
|---|---|---:|---|---|
| S1 | Authenticated requests repeated network identity admission | High | IMPLEMENTED — MEASURE | Deploy and prove one GoTrue/lifecycle admission plus end-to-end timing under the signed-in mix |
| S2 | Upload admission was globally serialized and O(active reservations) | High | LOCAL DB PASS — E2E LOAD | Database function passed 10k/100k/1m and 50-way concurrency; measure the complete sign/Auth/PostgREST/Storage path |
| S3 | Upload reclaim lacked scan/time bounds and growth visibility | High | IMPLEMENTED — LOAD | Prove steady-state drain/backlog age under protected-row fixtures; the clean local replay passes |
| S4 | No green current production performance baseline | High | OPEN | Green signed-out, signed-in and frontend budgets on a commit containing the new identity/upload paths |
| S5 | Feed-fact pruning remains the known steady-state write ceiling | High | REVALIDATE | Fresh facts/session and prune-throughput measurements with steady-state aged data |
| S6 | PostgreSQL rate limiting adds a write to hot public reads | Medium | LOCAL DB PASS — ORIGIN LOAD | Include limiter calls, rows, WAL, lock wait and P95/P99 latency in the deployed isolated origin write budget |
| S7 | New durable tables lacked complete growth/retention accounting | Medium | IMPLEMENTED — MEASURE | Record bytes/business event and set operational alerts from measured growth |
| S8 | Catalog payload and frontend budgets were failing | Medium | PARTIAL — REVALIDATE | Catalog body is locally compliant; production P99 and mobile Lighthouse still require a green run |

## Evidence snapshot

- The exact reviewed base commit and diff were read locally. The remediation is
  currently an uncommitted working-tree change and must be tied to its eventual
  release commit before certification.
- The performance harness self-test passed: five signed-out edge targets, one
  signed-in target and one origin target.
- Full web suite: 694 files / 4,801 tests passed.
- Full mobile suite: 114 files / 1,093 tests passed.
- Web/mobile typechecks, scripts/tests typechecks, lint, production build,
  build-artifact verification and `git diff --check` passed. The build retained
  the pre-existing Turbopack dynamic-ffmpeg tracing warnings.
- Production dependency audit: zero known vulnerabilities (`npm audit --omit=dev`).
- Local catalog schema v3 projection: 56,106 decoded bytes for web and mobile;
  schema v2 remains 64,497 bytes for installed transition clients.
- A clean local Supabase reset/replay passed with the CI-pinned CLI 2.75.0. The
  full database suite passed (50 files / 991 assertions), public-schema lint
  reported no errors, upload counters reconciled with zero drift, and the new
  counter trigger plus reclaim/defer/merge-retention indexes were present.
- A disposable local database benchmark populated both upload reservations and
  backend limiter rows at 10k, 100k and 1m. It ran five rounds of 50 concurrent
  operations for each workload/tier (1,500 total). Upload P95 was 46.963 ms at
  10k and 47.854 ms at 1m (1.019x); rate-limit P95 was 5.559/5.741 ms (1.033x).
  All operations passed and every upload counter reconciliation had zero drift.
  This excludes Auth, PostgREST, Storage, CDN, Vercel and network latency.
- A post-1m Supabase inspection bundle captured database/table/index/traffic,
  statement, lock, bloat, vacuum and hot-path plans. The pinned CLI's
  `role-stats` command hit its nullable-field bug, so equivalent read-only SQL
  role/connection evidence was captured. Local `track_io_timing` was off and is
  explicitly not treated as production I/O evidence.
- The post-1m plans use `backend_rate_limits_pkey` for expiry lookup and
  `upload_byte_reservations_expired_reclaimable_idx` for reclaim candidates.
  `pg_stat_statements` recorded 760 local limiter calls at 0.481 ms mean database
  execution time; concurrent client P95/P99 are reported above.
- Account deletion, upload reclaim/backlog, generation-input rollback and
  Showcase cache backfill now use Storage `listV2` opaque cursors instead of
  deep offsets/recursive folder pages. A live local Storage API contract probe
  returned the expected list-v2 cursor response shape.
- The linked remote migration check now completes over SSL after adding this
  machine as a single-address `/32` database restriction. It reports 173
  aligned versions, 38 local-only versions and 36 remote-only versions. Matching
  by migration name accounts for all 36 generated remote versions; 29 retain
  the exact repository SQL, six are history-only rows with no statements, and
  one differs in an escaped regular-expression literal. The remaining two
  local-only versions are the new scaling migrations in this change and are not
  deployed to production.
- A linked `db diff` confirms the same deployment boundary: production lacks
  the upload admission counter tables/trigger, the reclaim scheduling column
  and indexes, counter reconciliation, merge-ticket pruning, reclaim health,
  and expanded operational-growth accounting added by those two migrations.
  The repository's release ordering still applies: commit/release migrations
  first, then run the existing ledger-repair workflow from `main`; do not run
  `supabase migration repair` against this uncommitted worktree.
- Live Supabase advisors currently report zero security errors and zero
  performance errors or warnings. Security has 41 warnings, dominated by
  intentionally exposed `SECURITY DEFINER` RPCs and RLS policies applicable to
  anonymous signed-in users; each remains subject to contract-level review,
  not blanket automated removal. Leaked-password protection is enabled. CAPTCHA
  is not configured for the enabled anonymous sign-in flow.
- A value-free Vercel environment inventory initially confirmed
  `IDENTITY_ADMISSION_SECRET` was absent from both preview and production. A
  value containing 48 random bytes encoded as hex is now stored as a sensitive
  Production variable without exposing it in command output. Preview remains
  intentionally unset until an isolated certification environment exists. A
  candidate Production-configured
  deployment must still prove proxy-to-route assertion reuse end to end.
- The five most recent `Production Performance` workflow runs are all failures.
  The latest available run, 2026-08-17, had valid bot credentials and passed its
  signed-in feed target, but failed the overall load budget on generation-catalog
  response size/P99 latency and failed mobile Lighthouse budgets. It predates the
  2026-08-19 identity and upload changes, so it does not measure the current hot
  path. [GitHub run 31993250721](https://github.com/112kratoss/ugc-copy/actions/runs/31993250721)
- The ignored local `certification-artifacts/` directory still contains the raw
  `c1d494e` certificate bundle. No current-commit certificate bundle exists.

## Ordered next work

1. Deploy with the configured Production `IDENTITY_ADMISSION_SECRET`, verify
   backend environment health, and include the PostgreSQL public-read limiter in
   every origin measurement. Configure a separate Preview value only for an
   isolated preview certification environment.
2. Extend the passed 10k/100k/1m local database benchmark to the deployed
   sign/Auth/PostgREST/Storage path and the reclaim worker. Record Storage
   latency, CPU, scan/action/time ceilings and oldest actionable age.
3. Get the scheduled production performance workflow green. Treat its edge
   checks as regression monitoring, not capacity certification.
4. Re-measure feed facts/session and prune throughput on aged steady-state data.
5. Freeze a release candidate and follow
   [`scaling-certification-runbook.md`](scaling-certification-runbook.md) on
   fresh isolated fixtures. Include authenticated web, mobile API, uploads,
   generation, feed events, workflow, webhooks and background drains.
6. Publish a new exact-build certificate. Only that report may convert measured
   throughput into MAU scenarios.

## Document rules

- This file contains current conclusions only. Do not append investigation
  transcripts or per-commit change logs.
- Put detailed findings in a dated findings file and close them with evidence.
- Put every capacity result in a separate certificate tied to a full commit,
  schema fingerprint, catalog revision, fixture and workload definition.
- Archive superseded audits; never rewrite historical measurements to describe a
  later build.
