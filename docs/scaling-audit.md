# Current Scaling Assessment

Last reviewed: 2026-08-23
Reviewed base commit: `0345d786ffb86a44c5cc997414997a073f1ace6b`
Remediation release commit: `277482e3a528d65ddea029db52a3fb5db0a5f4ce`
Fix state: **deployed; Quality, protected release, and production performance checks passed**
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
The full web, mobile and database suites pass on the released commit. The
current production regression baseline is also green for all signed-out edge
targets, the authenticated For You target, and mobile/desktop Lighthouse.

However, the old 2,026/4,559 authenticated-web MAU scenarios must not be used as
current capacity. They came from a scoped certificate for `c1d494e`; the reviewed
base was 83 commits and 569 changed files later.

The fresh audit's actionable source findings now have implementations:

1. Authenticated route admission is passed from the proxy in a short-lived HMAC
   assertion bound to bearer token, method and path. Route Auth/lifecycle helpers
   verify and reuse it, while direct/rolling calls retain the fail-closed database
   fallback. Proxy time is included in authenticated performance timing.
2. Upload byte admission uses transactionally maintained per-user and singleton
   counters instead of reservation sums/global advisory locking. Reclaim has
   independent scan, action and wall-clock ceilings, defers protected rows, and
   exports backlog/counter health.
3. Public feed/detail/comments reads retain PostgreSQL admission as a deliberate
   no-extra-service constraint whose write cost must be included in the next
   certificate. Durable tables are included in growth accounting, merge tickets
   have bounded retention, and the compact catalog v3 response is 56,106 bytes
   locally versus the 57,344-byte budget while v1/v2 remain compatible.

These are deployed source fixes plus a green bounded production regression run,
not a capacity certificate. The two new
migrations replay cleanly against a disposable local Supabase database, pass the
full pgTAP suite, and are present in Production. Local 10k/100k/1m database
fixtures verify bounded upload admission and PostgreSQL rate-limit behavior, but
exclude Auth, PostgREST, Storage, CDN, Vercel and network costs. The identity
assertion secret is configured in Production and the protected release health
gate passed. A 90-second production edge run measured 1,068 successful reads,
including 40 authenticated For You reads, but no current isolated mixed-workload
run has measured uploads, writes, providers and background drains together under
sustained load.

## What can be claimed today

| Claim | Current status |
|---|---|
| Public cached pages and recent-feed reads are guarded by production budgets | **Green on exact production commit `277482e`** |
| S1-S3/S7 source remediations | **Deployed; tests/build/release health green, sustained-load evidence pending** |
| S8 catalog/frontend regression | **Closed; production payload and mobile/desktop budgets green** |
| S2 local database admission at 10k/100k/1m rows | **Passed; 50 concurrent × 5 rounds per tier, zero drift/failures** |
| S6 no-subscription public-read limiter decision | **Local database cost measured; deployed origin write budget still required** |
| Catalog v3 decoded body in the green production run | **55,915 bytes P95; under 57,344-byte budget** |
| Authenticated For You production edge regression | **40/40 passed; P95/P99 TTFB 1,671.6/1,746.4 ms** |
| Mobile frontend regression | **Green; representative Home LCP 1,196.2 ms** |
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
| S1 | Authenticated requests repeated network identity admission | High | DEPLOYED; EDGE PASS — MIXED LOAD | One proxy admission plus route reuse is timed; prove it across the full signed-in mix |
| S2 | Upload admission was globally serialized and O(active reservations) | High | DEPLOYED; LOCAL DB PASS — E2E LOAD | Database function passed 10k/100k/1m and 50-way concurrency; measure the complete sign/Auth/PostgREST/Storage path |
| S3 | Upload reclaim lacked scan/time bounds and growth visibility | High | DEPLOYED — LOAD | Prove steady-state drain/backlog age under protected-row fixtures; the clean local replay passes |
| S4 | No green current production performance baseline | High | CLOSED — MONITORED | Keep the exact-commit production workflow green; this is not a capacity certificate |
| S5 | Feed-fact pruning remains the known steady-state write ceiling | High | REVALIDATE | Fresh facts/session and prune-throughput measurements with steady-state aged data |
| S6 | PostgreSQL rate limiting adds a write to hot public reads | Medium | LOCAL DB PASS — ORIGIN LOAD | Include limiter calls, rows, WAL, lock wait and P95/P99 latency in the deployed isolated origin write budget |
| S7 | New durable tables lacked complete growth/retention accounting | Medium | DEPLOYED — MEASURE | Record bytes/business event and set operational alerts from measured growth |
| S8 | Catalog payload and frontend budgets were failing | Medium | CLOSED — MONITORED | Production catalog and mobile/desktop Lighthouse budgets are green; retain regression gates |

## Evidence snapshot

- The exact reviewed base commit and diff were read locally. Final remediation
  commit `277482e3a528d65ddea029db52a3fb5db0a5f4ce` passed the protected Quality
  and Production release workflows; the release verified the exact commit at
  staging and Production and required protected health after promotion.
  [Quality run](https://github.com/112kratoss/ugc-copy/actions/runs/32591318333),
  [Production release](https://github.com/112kratoss/ugc-copy/actions/runs/32591772254)
- The performance harness self-test passed: five signed-out edge targets, one
  signed-in target and one origin target.
- Full web suite: 697 files / 4,811 tests passed.
- Full mobile suite: 114 files / 1,093 tests passed.
- Web/mobile typechecks, scripts/tests typechecks, lint, production build,
  build-artifact verification and `git diff --check` passed. The build retained
  the pre-existing Turbopack dynamic-ffmpeg tracing warnings.
- Production dependency audit: zero known vulnerabilities (`npm audit --omit=dev`).
- The unchanged Production Performance workflow passed all three jobs on the
  exact live commit: 1,068 requests/zero errors in the 90-second load phase,
  required signed-in coverage, mobile Lighthouse and desktop Lighthouse.
  [Production Performance run](https://github.com/112kratoss/ugc-copy/actions/runs/32591925400)
- Authenticated For You served 40/40 requests successfully at P95/P99 TTFB
  1,671.6/1,746.4 ms (budgets 1,800/3,500). Phase telemetry shows route Auth
  assertion reuse at P95 1.5 ms, session reuse/page at 28.1/216.7 ms, total
  feed work at 300.2 ms, and the single proxy identity boundary at 882.6 ms.
  This closes the duplicate-write tail and makes the remaining admission cost
  explicit; it does not certify the entire authenticated workload.
- The production catalog was a 100% CDN HIT at 55,915 decoded bytes and P95/P99
  TTFB 78.6/128.2 ms. Public recent feed was P95/P99 92.5/142.2 ms. Home was
  P95 74,746 encoded and 682,097 decoded bytes, both within its budgets.
- Representative mobile Lighthouse: Home LCP/TBT/CLS 1,196.2 ms/127.4 ms/0,
  Showcase 2,221.9 ms/144.0 ms/0, Marketplace 1,226.9 ms/117.5 ms/0.
  Representative desktop: Home LCP/TBT 778.7 ms/0, Showcase 2,436.4 ms/0,
  Marketplace 1,581.5 ms/0. All enforced budgets passed.
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
- The linked remote migration check completes over SSL after adding this machine
  as a single-address `/32` database restriction. After the protected release,
  the repository ledger-repair workflow normalized the 38 generated remote
  versions, retained a timestamped backup, and independently verified all 211
  versions, names and recorded statements. The repository drift checker reports
  211 aligned migrations and Supabase `db push --dry-run --linked` reports no
  pending migrations. [Ledger verification](https://github.com/112kratoss/ugc-copy/actions/runs/32584934377)
- A post-release linked schema dump confirms the upload admission counter
  tables/trigger, reclaim scheduling column and indexes, counter reconciliation,
  merge-ticket pruning, reclaim health, and expanded operational-growth
  accounting are present in Production.
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
  intentionally unset until an isolated certification environment exists. The
  protected Production release and health gate passed with the variable present.
  The authenticated production edge run proves proxy-to-route assertion reuse
  for For You; the full signed-in certificate mix remains outstanding.
- Earlier Production Performance runs were retained as failure evidence. The
  final run above is the first fully green current-commit baseline after closing
  catalog, caching, main-thread, Home LCP, Showcase TTFB and authenticated feed
  tails without widening budgets.
- The ignored local `certification-artifacts/` directory still contains the raw
  `c1d494e` certificate bundle. No current-commit certificate bundle exists.

## Ordered next work

1. Keep the scheduled exact-commit production performance workflow green and
   investigate regression trends, especially the proxy identity phase. Treat
   this as edge/frontend monitoring, not a capacity certificate.
2. Extend the passed 10k/100k/1m local database benchmark to the deployed
   sign/Auth/PostgREST/Storage path and the reclaim worker. Record Storage
   latency, CPU, scan/action/time ceilings and oldest actionable age.
3. Re-measure feed facts/session and prune throughput on aged steady-state data.
4. Freeze a release candidate and follow
   [`scaling-certification-runbook.md`](scaling-certification-runbook.md) on
   fresh isolated fixtures. Include authenticated web, mobile API, uploads,
   generation, feed events, workflow, webhooks and background drains.
5. Publish a new exact-build certificate. Only that report may convert measured
   throughput into MAU scenarios.

## Document rules

- This file contains current conclusions only. Do not append investigation
  transcripts or per-commit change logs.
- Put detailed findings in a dated findings file and close them with evidence.
- Put every capacity result in a separate certificate tied to a full commit,
  schema fingerprint, catalog revision, fixture and workload definition.
- Archive superseded audits; never rewrite historical measurements to describe a
  later build.
