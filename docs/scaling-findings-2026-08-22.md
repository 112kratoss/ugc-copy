# Scaling Findings — 2026-08-22

Scope: initial static re-audit of
`0345d786ffb86a44c5cc997414997a073f1ace6b`, remediation released as
`1bf065bffda8899e9de3f4ba73ea66baf9cc181d`, full source/build/release
verification, the stored historical certificate artifacts, and the latest
available production performance workflow evidence.
This is not a load certificate.

## S1 — Authenticated requests repeat network identity admission

Severity: **High**
Status: **DEPLOYED — SUSTAINED MEASUREMENT REQUIRED**
Introduced after certified build: **Yes**

### Evidence

`src/proxy.ts` runs for every `/api/:path*` request. When a bearer token is
present, `guardUserFacingRouteIdentity` performs:

1. `client.auth.getUser()` against GoTrue; then
2. `current_identity_state()` against PostgREST/Postgres.

The proxy comments explicitly say route adapters verify Auth independently.
That second boundary routes through `account-identity.ts`, which performs
another `getUser()` and then a service-role `profiles.identity_state` lookup.
Public optional-auth routes repeat at least the Auth half: the showcase feed
calls `getUser()` again after the proxy, then calls the database rate limiter.

This reopens and expands the old F8 issue. The earlier local-JWKS fix remains in
`getServerAuthState()` for React Server Components, but it does not cover bearer
API traffic.

### Remediation implemented

The proxy remains the authoritative bearer boundary, but now signs its verified
user/lifecycle result with `IDENTITY_ADMISSION_SECRET`. The assertion expires in
30 seconds and is bound to the bearer-token hash, method and pathname. The proxy
strips caller-supplied assertion/timing headers before forwarding it.

`createUserClient()` registers the request assertion; `getVerifiedAuthUserResult`
and `requireIdentity` verify and reuse it. A route invoked directly, through a
rolling old proxy, or with an invalid assertion falls back to the existing
GoTrue/profile checks and fails closed. Certification-only feed timing now
includes the proxy identity phase. Unit/integration tests cover signature,
expiry, token/method/path binding, lifecycle reuse, caller-header stripping and
merged/deleting/guest rejection.

### Scaling effect

- Authenticated latency contains multiple sequential control-plane round trips
  before business work begins.
- GoTrue and PostgREST connection demand scale with API request count rather
  than signed-in session count.
- Optional-auth hot reads pay the proxy cost even when their route logic needs
  only the verified subject.
- Existing route `Server-Timing` starts after the proxy, so its `auth` phase
  under-reports the full admission cost.

The lifecycle check is a real security requirement: merged/deleting identities
must fail closed. Removing a boundary without replacing its trust property is
not an acceptable optimization.

### Acceptance

- Preserve authoritative merged/deleting/guest admission.
- Perform no more than one network GoTrue verification and one indexed identity
  lifecycle lookup per request.
- If the proxy passes admission to the route, the assertion must be unforgeable,
  short-lived and bound to method/path/subject, with caller-supplied versions
  stripped. Otherwise keep the authoritative check in the route and make the
  proxy a non-authoritative hint.
- Add timing that covers proxy plus route phases.
- Re-run the full signed-in certificate mix, not only the for-you GET.

## S2 — Upload admission is globally serialized and O(active reservations)

Severity: **High**
Status: **DEPLOYED; LOCAL DATABASE LOAD PASSED — END-TO-END LOAD REQUIRED**
Introduced after certified build: **Yes**

### Evidence

`reserve_upload_bytes_v2` takes the global advisory lock
`upload-byte-admission` for every signed upload. While holding it, the function
computes a per-user sum and a global sum over every reservation whose
`released_at IS NULL`. The active indexes are led by `(user_id, id)` and `(id)`;
there is no constant-size aggregate row.

The reservation stays unreleased through sign, finalization and consumption.
Preserved objects are reconciled and released later by a daily worker. Legacy
preserved rows intentionally remain charged until compatibility contraction.
Therefore both lock hold time and rows scanned per upload can grow with upload
traffic and cleanup lag.

### Remediation implemented

Migration `20260822120000_bound_upload_admission_and_reclaim.sql` replaces both
request-path sums and the global advisory lock with one indexed per-user counter
row and one singleton global counter row. A reservation trigger maintains exact
charges transactionally across insert/update/delete, including the existing
actual-byte/tombstone rule. A service-role reconciliation RPC reports global and
per-user drift and can repair it under a reservation-table lock.

Exact global admission still serializes briefly on one aggregate row; the
critical section is now constant-size indexed work rather than a scan whose cost
grows with reservations. A clean local replay, the full pgTAP suite and a
zero-drift reconciliation pass. A disposable local database benchmark also
passed at 10k, 100k and 1m reservation rows with five rounds of 50 concurrent
admission calls per tier. Upload P95 was 46.963 ms at 10k and 47.854 ms at 1m
(1.019x); P99 was 53.723/54.007 ms. The expected singleton-row contention was
visible, and every counter reconciliation reported zero drift. This proves the
database critical section remains bounded locally; the HTTP sign, Auth,
PostgREST, Storage API and network path still require isolated end-to-end load.

### Scaling effect

- All upload surfaces share one global serialization point.
- A large protected/unreleased set increases the cost inside that lock.
- Concurrent upload starts queue behind database work before any Storage PUT.
- The failure mode can appear as sign latency, function concurrency growth and
  global upload rejection even while Storage itself is healthy.

### Acceptance

- Benchmark 10k/100k/1m unreleased-row fixtures with realistic state mixes.
- Drive at least 50 concurrent sign requests across different users and upload
  surfaces; record lock wait, transaction time, WAL, CPU and P95/P99 latency.
- Replace repeated global sums with transactionally maintained counters or
  another demonstrably constant/bounded design, plus a drift reconciliation
  query. Do not weaken byte-admission correctness.
- Include the new path in strict replay/finalization/account-deletion cases.

## S3 — Upload reclaim is not scan/time bounded and is invisible to growth telemetry

Severity: **High**
Status: **DEPLOYED — LOAD REQUIRED**
Introduced after certified build: **Yes**

### Evidence

`reclaimExpiredUploadReservations` declares a limit of 500 in the daily
operational-retention call, but its outer loop stops on `handled`, not rows
scanned. Protected mobile drafts, active consumption leases, quarantined exact
objects and legacy preserved rows can `continue` without increasing `handled`.
Keyset pagination advances, so a run with many protected expired rows can scan
the full eligible table while still reporting fewer than 500 handled actions.

The candidate query filters on `expires_at` but orders by `id`. The current
partial reclaim index is also led only by `id`, so expiry filtering is not the
leading access path. Actionable rows may then perform sequential Storage
metadata/delete requests inside the same shared 300-second job.

`upload_byte_reservations` and `upload_path_tombstones` are not included in
`get_operational_table_growth`. The tombstone table deliberately receives a row
when an upload enters finalization/consumption/reclaim states and has no
retention policy. This may be correct security retention, but its cost is not
currently visible.

### Scaling effect

- A nominally bounded daily job can become O(all protected expired rows).
- Slow Storage metadata calls can exhaust the shared scheduler invocation.
- Admission can degrade before operations dashboards show the underlying table
growth or cleanup lag.

### Remediation implemented

Reclaim now has separate action (default 500), scan (default max of 500 or 4×
actions, capped at 20,000) and wall-clock (default four minutes, capped below the
shared 300-second invocation) ceilings. Candidates use `(expires_at, id)` keyset
order and a matching expiry-led partial index. Protected rows receive a durable
`reclaim_after` scheduling hint based on the compatibility window, lease expiry,
quiescence window or longer legacy retention, so they are not selected every
day.

The summary reports scanned/handled rows, both ceiling flags and oldest candidate
expiry. Backend cost health now reports bounded-at-20,000 actionable/deferred
samples and ages, outstanding bytes, statistical tombstone rows and counter
drift; its own probes therefore do not become unbounded scans. Operational
growth includes reservations, per-user counters and the permanent tombstone
ledger. Source tests
exercise protected legacy rows and the independent bounds; steady-state drain
and index plans remain deployment/load gates.

### Acceptance

- Separate scan limit, action limit and wall-clock budget; report all three.
- Select only actionable states with an expiry-led partial index or an atomic
  claim RPC. Protected permanent states must not be re-scanned daily.
- Expose oldest actionable age, scanned rows, handled rows, failed rows, table
  bytes and tombstone bytes in backend health/cost reports.
- Prove steady-state drain at more than the certified upload arrival rate with
  30% headroom.
- Isolate the worker if Storage calls can still consume the shared invocation.

## S4 — No green current production performance baseline

Severity: **High (evidence gate)**
Status: **OPEN**

The five latest `Production Performance` workflow runs available on 2026-08-22
are failures. The newest, from 2026-08-17, successfully authenticated the bot and
passed its one signed-in feed target, but the run failed because the generation
catalog response exceeded its decoded-body budget and breached P99 latency.
Mobile Lighthouse also breached home/showcase LCP and marketplace interactive
budgets. [Run evidence](https://github.com/112kratoss/ugc-copy/actions/runs/31993250721)

That run predates the S1-S3 remediation. The weekly edge workflow is valuable regression
monitoring, but it drives only one authenticated GET and cannot certify writes,
uploads, provider callbacks, workflows, background drains or sustained origin
capacity.

Acceptance: obtain a green run for the current paths, then execute the isolated
mixed-workload certificate. Do not turn persistent failures green by widening
budgets without explaining the payload/latency change and measuring its effect.

## S5 — Feed-fact pruning remains the known steady-state write ceiling

Severity: **High**
Status: **REVALIDATE**
Introduced after certified build: **No**

The feed still writes delivery/session facts and prunes at 5,000 rows per hourly
sweep. That is 120,000 rows/day before reserve, or 84,000/day after the historical
30% headroom rule. The historical certificate measured 46.054 facts per ranked
session and was retention-bound in every MAU scenario.

Cursor preservation, served-slice persistence, daily rollups and 30-day raw
retention remain present. Mobile event batching has improved since the
certificate. None of that establishes the current facts/session distribution or
steady-state prune cost after the later schema changes.

Acceptance: measure fresh facts/session, sessions/DAU, prune rows/second, WAL,
table/index growth and oldest-fact lag on a pre-aged fixture. Raise a capacity
claim only after an aged soak proves the backlog shrinks with reserve.

## S6 — PostgreSQL rate limiting adds a write to hot read paths

Severity: **Medium**
Status: **ACCEPTED CONSTRAINT — MEASUREMENT REQUIRED**

`enforceBackendRateLimit` is referenced across 82 `src/lib` modules. Each check
calls `check_backend_rate_limit`, which deletes stale rows for that subject and
upserts the current fixed-window row. Public feed, detail and comments reads
therefore generate Postgres writes even for cached/cheap application work, and
rejected abuse traffic continues generating limiter transactions.

The historical 7 ops/s certificate included the then-current limiter, so this is
not evidence of immediate failure. It is a write-amplification wall for a public
read-heavy product. Keep database admission for money and correctness-sensitive
mutations and certify the public-read write budget explicitly.

Supabase's native Data API pre-request hook cannot rate-limit `GET` or `HEAD`
because those requests execute in read-only transactions. Supabase's official
Edge Function rate-limit example uses an external Redis provider. The product
has deliberately chosen not to add another subscribed service, and an
instance-local serverless map would not be a distributed or trustworthy
replacement.

### Implemented decision

The unfinished external Redis optimization and its deployment requirements were
removed. Public feed, for-you feed, post-detail and comments reads always use the
existing PostgreSQL limiter, keyed by verified subject or salted network
identity. CDN/application caching remains the write-avoidance layer before the
origin. The finding is not closed: the next isolated workload must report
`check_backend_rate_limit` calls, rows, WAL, lock wait and P95/P99 latency, and
the capacity claim must include that cost.

The disposable local database benchmark populated 10k, 100k and 1m limiter
rows and ran five rounds of 50 concurrent calls per tier. P95 was 5.559 ms at
10k and 5.741 ms at 1m (1.033x); P99 was 5.864/6.011 ms, with zero failures.
This is database-function evidence only, not proof of the public origin route,
CDN behavior or multi-source anonymous capacity.

## S7 — New durable tables lack complete growth and retention accounting

Severity: **Medium**
Status: **DEPLOYED — MEASUREMENT REQUIRED**

Post-certificate features added durable state that is absent from the operational
growth RPC, including upload reservations/tombstones and account-merge tickets.
Expired or consumed merge tickets have an index but no cleanup policy. Workflow
runs retain a graph snapshot and step input/output snapshots as user history;
there is no size budget or archive policy. Permanent rows can be the correct
security/product choice, but the capacity model must include them.

Acceptance: inventory append-only/growth-sensitive tables, add them to growth
reporting, record bytes per business event, and assign one of: bounded retention,
user-controlled history, permanent security ledger, or external archive.

### Remediation implemented

`get_operational_table_growth()` now includes merge tickets, upload reservations,
upload user counters, upload tombstones, template runs/steps, workflow canvas
runs/steps and workflow step jobs alongside the existing operational tables.
Budgets were added to the backend report for every newly reported table.

Expired merge tickets are deleted in indexed, locked batches after a 30-day
post-expiry evidence window. Workflow/template run graphs remain user-controlled
history and are monitored rather than silently deleted. Upload tombstones remain
a permanent replay-prevention ledger; their row/byte cost and the outstanding
reservation population are now visible. Clean local replay passes; measured
bytes per business event are still required before setting production alert
thresholds.

## S8 — Catalog payload and frontend budgets are failing

Severity: **Medium**
Status: **PARTIAL — CATALOG SOURCE DEPLOYED; PRODUCTION/FRONTEND REVALIDATION REQUIRED**

The 2026-08-17 production run measured the generation-model catalog at 64,306
decoded bytes P95 against a 57,344-byte budget, with 2,219.5 ms P99 TTFB against
1,500 ms. The catalog expanded again in repository work after that run. The
current endpoint is cached and revision-aware, which limits database load, but
every cold client still downloads and parses the full public projection.

Acceptance: measure the current production payload by platform/schema version;
remove fields clients do not need, split static capability detail from the hot
selection projection, or deliberately set a new measured budget. Restore green
mobile Lighthouse budgets independently of capacity certification.

### Remediation implemented

Catalog schema v3 removes the redundant legacy `inputs` object from the wire;
the same limits are reconstructed after validation from `inputModes` in web and
mobile clients. Stored descriptors and schema v2 responses are unchanged, so
installed transition clients keep their contract and catalog release hashes do
not churn for a transport-only change. The compatibility policy now advertises
v1/v2/v3 and mobile uses a separate v3 cache namespace.

The current local web and mobile schema-v3 projections are both 56,106 decoded
bytes, below the 57,344-byte budget. Schema v2 remains 64,497 bytes by design for
backward compatibility. Route/client tests enforce the v3 budget and both v2/v3
parsing. This closes the source payload defect, not the historical production
P99 or mobile Lighthouse failures; those remain S4 evidence gates.

## Controls revalidated in source

These are not open findings, and they are not capacity proof:

- Feed video admission prefers an eight-second teaser for long sources, then a
  bounded rendition, and returns poster-only rather than raw source while a
  transcode is unresolved.
- Media repair uses leases, byte admission, sequential ffmpeg and a dedicated
  Vercel cron.
- Web feed cursor continuation and list windowing remain covered.
- Web feed events and the mobile offline queue batch telemetry.
- Workflow starts retain idempotent durable jobs and provider capacity slots.
- Feed retention is 30 days with daily rollups and a constant-cost lag probe.
- The performance harness refuses to label missing signed-in coverage as
  certified.
- Storage maintenance scans use cursor-based `listV2` flat prefix iteration,
  including account deletion, upload reclaim/backlog seeding, generation-input
  rollback and Showcase cache backfill. Invalid/repeated cursors and
  out-of-prefix objects fail closed.
- `npm run db:inspect:performance` captures Supabase database/table/index,
  traffic, statement, lock, bloat, vacuum, role and application hot-path
  evidence without executing mutation plans.

Verification performed after remediation:

```text
performance load self-test: PASS
web full suite:              694 files / 4,801 tests passed
mobile full suite:           114 files / 1,093 tests passed
web production build:        PASS
build artifact verification: PASS
web/mobile typechecks:       PASS
scripts/tests typechecks:    PASS
lint + git diff check:       PASS
production dependency audit: 0 known vulnerabilities
clean local migration replay: PASS (Supabase CLI 2.75.0)
database pgTAP suite:         50 files / 991 assertions passed
public-schema database lint:  PASS
upload counter reconciliation: status=ok / zero drift
local DB fixture benchmark:  PASS (10k/100k/1m; 50 concurrent x 5 rounds)
local Storage list-v2 probe: PASS (cursor response contract)
linked migration connection: PASS (SSL + single-address /32 allow-list)
linked migration parity:     PASS (211 aligned; zero pending migrations)
production schema presence:  PASS (linked post-release schema dump)
protected production release: PASS (exact commit + post-promotion health)
production ledger replay:    PASS (211/211 versions/names/statements exact)
Supabase performance advisor: 0 errors / 0 warnings
Supabase security advisor:    0 errors / 41 warnings
```

A clean local Supabase replay and pgTAP pass. The protected release deployed both
scaling migrations and the Production-configured application, verified the exact
commit after promotion, and passed production health. The post-release ledger
workflow retained a backup and independently verified that all 211 production
rows reproduce the repository exactly; the linked dry-run reports no pending
migrations. A clean isolated-branch replay, a green current Production
Performance run, and sustained load tests remain certificate gates. The live
advisor scan is recorded above.
