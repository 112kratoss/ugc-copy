# Backend audit coverage tracker

Updated 2026-09-30. This is the shared area-level tracker, not a completion
percentage. A numbered fix batch is not a whole subsystem. A green inventory or
unit suite alone does not certify behavior at database, provider or client level.

## Inventory baseline

At main `041ff8a5` plus Section 5K, the existing checkout contains 162 API route
files, 201 files ending in `service.ts`, 13 cron route files (included in the
162), and 323 public Postgres function signatures on clean replay. These are
orientation counts, not a denominator: functions include triggers/helpers, some
business modules do not end in `service.ts`, and one feature spans many routes.
Source lists are preserved in `.audit-evidence/backend-section-05k/*-inventory.txt`.

Before reporting a percentage, map those inventories plus registered jobs to
unique behavioral obligations, link each obligation to evidence, and distinguish
passed, failed, untested and externally blocked checks. That mapping is pending.

## Behavioral coverage

| Area | Established evidence | Remaining work |
| --- | --- | --- |
| Authentication/account lifecycle | Section 1 and follow-ups; native Apple, Chrome web and admin login/logout verified | Disposable-account deletion/provider revocation, mobile Google deep links, JWT rotation, compatible CAPTCHA rollout |
| Database ownership/permissions | Section 2 ownership/grant/RLS work; subsequent money RPC permission regressions | Map every privileged RPC/table to callers and behavior; cover remaining noncommerce surfaces |
| Credits/payments/refunds | Sections 3–5; atomic settlement, receipt identity, event identity, reversal binding, rollback and concurrency evidence | Actual provider-backed purchase/refund delivery; remaining ordering/recovery combinations |
| Marketplace/creator earnings/payouts | Earlier Section 5 batches plus deployed 5J; 5K fixes legacy restore ownership, a restore/repurchase deadlock and duplicate revenue reporting (deployed in PR #246 on `b04ccb46`) | Complete web/mobile/credit lifecycle matrix, creator payout recovery and reporting edge cases (5L detached reporting deployed in PR #247); genuine provider events |
| Generation/provider callbacks | Prior implementation tests; Section 6A local 20-way queue, lease, settlement and task-attachment races passed; Section 6B incomplete-output callback/polling bug deployed in PR #248 with real-DB recovery checks | Systematic start/callback/poll races, failures, refunds and recovery with provider evidence |
| Workflow/template execution | Prior implementation tests and partial ownership checks | Execution authorization, partial failure, retries, cancellation, recovery and billing invariants |
| Media/storage/signing/retention | Prior implementation tests and partial ownership checks | Upload/import validation, signed access, lifecycle deletion and retention behavior |
| Posts/feeds/moderation/community | Prior implementation tests and partial ownership checks | Behavioral authorization, visibility, moderation propagation, pagination and community mutations |
| Jobs/cron/retries/operations | Existing registry and operational tests | Lease contention, stale locks, retries, budgets, poison jobs and alert delivery |
| Deployment/recovery/backups/capacity | Each released batch uses exact-main Quality, migration/staging/live gates; separate scaling audits exist | Recovery/restore exercises and explicit reconciliation with current scaling certificates |

## Current sequence

1. Sections 5K and 5L are deployed. Section 5L live build is `65890e31`. Read-only production collectors reproduce the watchdog
   degradation: an overdue moderation report needs operator review. No report
   was dismissed; the live authenticated ops HTTP response remains unavailable locally.
2. Complete the remaining commerce lifecycle/payout matrix, separating synthetic
   database evidence from externally blocked provider delivery.
3. Section 6B is deployed. Release Section 6C video/motion durable polling
   (reproduced and fixed locally with six DB recovery regressions), then continue generation recovery and workflow/template
   execution; continue the other areas above without claiming them complete from
   code inventory alone.

The [handoff](backend-audit-handoff.md) records the exact checkout, live build,
release authorization and local evidence that must be preserved. Dated Section
reports contain the underlying findings, tests and release records.
