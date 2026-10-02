# Backend audit coverage tracker

Updated 2026-10-03. This is the shared area-level tracker, not a completion
percentage. The [completion checklist](backend-audit-completion-checklist.md)
now holds stable closure obligations and their evidence/status. A numbered fix
batch is not a whole subsystem. A green inventory or
unit suite alone does not certify behavior at database, provider or client level.

## Inventory baseline

At main `041ff8a5` plus Section 5K, the existing checkout contains 162 API route
files, 201 files ending in `service.ts`, 13 cron route files (included in the
162), and 323 public Postgres function signatures on clean replay. These are
orientation counts, not a denominator: functions include triggers/helpers, some
business modules do not end in `service.ts`, and one feature spans many routes.
Source lists are preserved in `.audit-evidence/backend-section-05k/*-inventory.txt`.

The October 1 [surface map](backend-audit-surface-map-2026-10-01.json) refreshes
the inventory at `5934bd7d`: 162 routes, 201 services, 323 public functions,
136 public relations and 12 registered jobs. Every route has a review gate;
seven services outside API routes have page callers, and eight indirect RPC
sites have reviewed names. Catalog data is from the isolated audit database.
The completion checklist distinguishes passed, failed, untested and external
obligations. Method-level/SQL/trigger/other-entrypoint reconciliation remains
MAP-02; this initial ledger is not yet a measured completion denominator.

## Behavioral coverage

| Area | Established evidence | Remaining work |
| --- | --- | --- |
| Authentication/account lifecycle | Section 1 and follow-ups; native Apple, Chrome web and admin login/logout verified | Disposable-account deletion/provider revocation, mobile Google deep links, JWT rotation, compatible CAPTCHA rollout |
| Database ownership/permissions | Section 2 ownership/grant/RLS work; subsequent money RPC permission regressions | Map every privileged RPC/table to callers and behavior; cover remaining noncommerce surfaces |
| Credits/payments/refunds | Sections 3–5; atomic settlement, receipt identity, event identity, reversal binding, rollback and concurrency evidence | Actual provider-backed purchase/refund delivery; remaining ordering/recovery combinations |
| Marketplace/creator earnings/payouts | Earlier Section 5 batches plus deployed 5J; 5K fixes legacy restore ownership, a restore/repurchase deadlock and duplicate revenue reporting (deployed in PR #246 on `b04ccb46`) | Complete web/mobile/credit lifecycle matrix, creator payout recovery and reporting edge cases (5L detached reporting deployed in PR #247); genuine provider events |
| Generation/provider callbacks | Prior implementation tests; Section 6A local 20-way queue, lease, settlement and task-attachment races passed; Section 6B incomplete-output callback/polling bug deployed in PR #248; Section 6C durable video/motion polling deployed in PR #249 with real-DB recovery checks; Section 6D grace/callback ordering checks and reconciliation retry fix deployed in PR #250; Section 6E incomplete creation-receipt recovery deployed in PR #251; Section 6F marker outage/reaper recovery deployed in PR #252; Section 6G nine actual process-kill recovery cases verified and merged in PR #253 | Systematic start/callback/poll races, failures, refunds and recovery with provider evidence |
| Workflow/template execution | Prior implementation tests and partial ownership checks | Execution authorization, partial failure, retries, cancellation, recovery and billing invariants |
| Media/storage/signing/retention | Prior implementation tests and partial ownership checks; Section 6H staging cleanup retry/concurrency/source cancellation deployed and verified in PR #254; Section 6I actual FFmpeg parent-death probe confirms the timeout does not bound an orphan reader; Section 6J inherited-lock reclamation deployed and verified in PR #255; legacy files/other scratch/disk admission remain open | Upload/import validation, signed access, lifecycle deletion and retention behavior |
| Posts/feeds/moderation/community | Prior implementation tests and partial ownership checks | Behavioral authorization, visibility, moderation propagation, pagination and community mutations |
| Jobs/cron/retries/operations | Existing registry and operational tests | Lease contention, stale locks, retries, budgets, poison jobs and alert delivery |
| Deployment/recovery/backups/capacity | Each released batch uses exact-main Quality, migration/staging/live gates; separate scaling audits exist | Recovery/restore exercises and explicit reconciliation with current scaling certificates |

## Current sequence

1. Sections 5K and 5L are deployed. Section 5L live build is `65890e31`. Read-only production collectors reproduce the watchdog
   degradation: an overdue moderation report needs operator review. No report
   was dismissed; the live authenticated ops HTTP response remains unavailable locally.
2. Complete the remaining commerce lifecycle/payout matrix, separating synthetic
   database evidence from externally blocked provider delivery.
3. Sections 6B–6H, 6J and 6L are deployed; live build `999c34d5`. Section 6D verifies grace
   expiry/callback ordering and fixes reconciliation-write retry. Section 6E
   incomplete receipt/start replay and Section 6F marker-write/reaper recovery
   are deployed and verified. Section 6G process termination checks passed CI and
   release. Section 6H cleanup completion/source cancellation is deployed and
   verified. Section 6I local actual-reader lifetime investigation is complete;
   parent death and directory age are insufficient deletion authority. An inherited
   lock primitive passes an isolated Linux/Node 24 proof. Section 6J packaging, reader
   integration and reclamation race tests pass locally and in CI; release attempt 2
   and independent live checks passed. Section 6K locally verifies sequential
   crash reclamation and active-reader preservation under disk pressure, but
   reproduces scan starvation behind 128 persistent entries and concurrent
   capacity oversubscription. Section 6L fixes MEDIA-05 scan progress and is
   deployed/verified in PR #256: successful reclamations are capped at 128,
   inspection is linear. Ledger: 22 passed, 27 untested, 1 failed, 3 external
   (not a completion percentage). Section 6M verifies four real disk-failure/DB
   recovery scenarios, including partial outputs and exhausted jobs reopened by
   callback/reaper, with stable balances and one success notification. No runtime
   change or release in 6M. Section 6N reproduces retained bytes in all five old
   scratch namespaces and output expansion beyond input size. New scratch leases
   and cancellation ordering pass real FFmpeg locally/in CI; deployed in PR #257.
   October 2 live build 626f398c contains this fix unchanged and 15 later PRs;
   their behavior remains subject to the same audit gates. Section 6O verifies
   194 compatibility tests and nine real worker-kill cases on that build, and
   shows candidate FFmpeg output limits can overshoot; no runtime change in 6O.
   Section 6P proves an inherited kernel per-file bound on Mac/Linux, including
   owner death and retained leases; no runtime change in 6P. Section 6Q integrates
   per-file limits into actual runners and passes local real-FFmpeg bounds,
   cancellation, normal/failure and orphan cleanup checks. PR #277 is deployed as
   a8dd6c1f with exact-main Quality and live health verified. Section 6R reproduces
   shared ENOSPC between bounded encoders. Its shared-admission fix is deployed in
   PR #281 (20862a0b), with exact-main Quality and standard release verified;
   MEDIA-06 passes for cooperating writers. Current main 24194f1d is incorporated.
   Section 6S locally fixes interrupted initialization, with legacy operational
   evidence still open under MEDIA-07. Next are workflow/template
   execution; continue the other areas above without claiming them complete from
   code inventory alone.

The [handoff](backend-audit-handoff.md) records the exact checkout, live build,
release authorization and local evidence that must be preserved. Dated Section
reports contain the underlying findings, tests and release records.
