# Backend audit completion checklist

Updated 2026-10-03. Current independently checked production: `24194f1d232af37fca43628bcfd07c74928c8296` (contains Section 6R); its later release run failed protected build-ID verification despite subsequent public-boundary checks passing.
Section 6N deployed as `149b9edc`; later product/notification changes are incorporated
in the audit checkout, not automatically credited as full audit coverage.
Surface inventory baseline remains `5934bd7d`; Section 6L changed no surfaces.

This is the closure ledger for the audit, replacing section numbers as a progress
measure. A row is a bounded obligation, not a subsystem percentage. The rows have
unequal effort and risk. Do not turn their pass count into a percentage of backend
safety or an ETA. New findings attach to these obligations; changes in scope must
be recorded explicitly instead of silently adding another lettered batch.

Current ledger: **53 obligations — 22 passed, 27 untested, 1 failed, 3 external**.
These counts describe this scoped checklist, not a percentage of the backend.

Status meanings: **passed** has evidence for the stated scope; **failed** has a
reproduction and remains open; **untested** lacks complete evidence for this
obligation (it may have earlier partial tests); **external** needs provider,
operator, device or environment evidence that local fixtures cannot supply.

The [surface map](backend-audit-surface-map-2026-10-01.json) records every current
API route and `*service.ts` file, the isolated database's public functions and
relations, and all registered jobs. File-level static reachability deliberately
over-approximates callers. Seven services without API callers have reviewed page
callers; eight indirect RPC sites have reviewed function names. The 152 functions
without identified JavaScript callers are **not** presumed unused: SQL callers,
triggers, scripts, edge code and mobile access remain MAP-02/DB-03 work. The local
catalog is not a fresh production snapshot.

## Closure gates

The surface map's `*-GATE` values refer to these groups. A gate stays open until
its untested/failed/external rows are resolved, with evidence at the real failure
layer. Route review includes every exported method, allowed and denied identities,
input limits, state transitions, retry behavior and relevant side effects. Domain
coverage includes shared helpers that do not end in `service.ts`.

| Gate | Included surfaces |
| --- | --- |
| AUTH-GATE | Account, onboarding, admin session; shared identity admission on all protected routes |
| DB-GATE | All 323 public functions and 136 public relations; grants, policies, triggers and callers |
| PAY-GATE | Credits, Razorpay, mobile commerce, referrals, admin credits, creator/admin payouts |
| MARKET-GATE | Marketplace, entitlements, resource bundles and resource files |
| GEN-GATE | Generation, provider callback, model catalog, prompt/source tools, generation lifecycle |
| WORKFLOW-GATE | Canvas, shares, assistant, templates, template runs and workflow jobs |
| MEDIA-GATE | Uploads, private media access, staging, preview/rendition scratch, deletion and retention |
| SOCIAL-GATE | Posts, feed, search, profiles, follows, comments, saves, moderation and contact |
| JOB-GATE | All 12 registered jobs, scheduler, ops collectors and mobile notifications |
| OPS-GATE | Release/recovery/capacity; app version, telemetry, CSP, FX, admin server-rendered collectors |

## Cross-cutting scope

| ID | Obligation and closure evidence | Status | Evidence / next action |
| --- | --- | --- | --- |
| MAP-01 | Capture route/service/job/public-catalog inventory and assign review gates | passed | [Surface map](backend-audit-surface-map-2026-10-01.json); 162 routes, 201 services, 323 functions, 136 relations, 12 jobs; 0 unassigned routes |
| MAP-02 | Reconcile method-level behaviors, non-API entrypoints, SQL/trigger callers, mobile direct access, edge and operational scripts to this ledger | untested | Static module paths are scheduling evidence only; inspect the 152 functions without identified JS callers and map tables to mutation/read paths |

## Authentication and database

| ID | Obligation and closure evidence | Status | Evidence / next action |
| --- | --- | --- | --- |
| AUTH-01 | Guest/profile, ban/session/lifecycle and signed-balance merge regressions | passed | [Section 1 report](backend-section-01-auth-2026-09-26.md) and the current handoff, including controlled live identity and merge checks; historical balances were not rewritten |
| AUTH-02 | Previously exercised native Apple, Chrome web and admin login/logout flows | passed | [Current handoff](backend-audit-handoff.md); this does not certify every provider or recovery flow |
| AUTH-03 | Disposable-account deletion through provider revocation, cleanup failure and restart | untested | Complete destructive flow and recovery on designated disposable identities |
| AUTH-04 | Mobile Google deep-link completion and remaining password/email/session recovery flows | untested | Real client/provider execution; reconcile earlier evidence before repeating checks |
| AUTH-05 | JWT key rotation/fallback and sessionless-token compatibility | untested | Controlled rotation environment and explicit legacy compatibility decision |
| AUTH-06 | CAPTCHA/rate configuration rollout compatible with installed clients | untested | Hosted configuration plus old/new client behavior, not configuration presence alone |
| DB-01 | Scoped workflow parent, financial, notification, social and projection ownership fixes | passed | [Section 2 ledger](backend-section-02-tables-2026-09-27.md) and its linked release records |
| DB-02 | Identified client-callable workflow RPC admission bypass | passed | [Section 3 release](backend-section-03-rpc-release-2026-09-27.md) |
| DB-03 | Remaining invoker/definer behavior, constraints and trigger invariants across mapped objects | untested | Resolve SQL-only call chains; positive/negative role and ownership fixtures for uncovered behavior |
| DB-04 | Realtime visibility and revocation behavior | untested | Actual subscription and lifecycle changes, including already-open connections |
| DB-05 | Deferred compatibility grant removal | untested | Verify supported clients before the separate rollout; do not remove grants merely to close this row |

## Payments, marketplace and payouts

| ID | Obligation and closure evidence | Status | Evidence / next action |
| --- | --- | --- | --- |
| PAY-01 | Credit grant identity/idempotency regressions | passed | [Credit grant release](backend-section-05-credit-grants-release-2026-09-28.md) |
| PAY-02 | Receipt/event identity and reversal target binding regressions | passed | [Receipt release](backend-section-05-receipt-identity-release-2026-09-29.md), [binding release](backend-section-05-credit-event-binding-release-2026-09-29.md), [event history](backend-section-05-mobile-event-history-release-2026-09-29.md) |
| PAY-03 | Reproduced refund/restore ordering and debt cases | passed | [Refund release](backend-section-05-refund-ordering-release-2026-09-28.md); the full event lifecycle matrix is PAY-04 |
| PAY-04 | Remaining credit, referral, refund/dispute/restore and reconciliation combinations | untested | Enumerate untested orderings first; real DB rollback and concurrency fixtures |
| PAY-05 | Genuine purchase/refund/webhook delivery and installed-client restore | external | Provider test credentials/accounts were unavailable in prior batches; synthetic events do not close this row |
| PAY-06 | Scoped payout transition and detached reporting defects | passed | [Payout release](backend-section-04-payouts-release-2026-09-27.md), [detached reporting](backend-section-05-payout-detached-reporting-release-2026-09-30.md) |
| PAY-07 | Creator payout crash recovery and reconciliation to external transfer outcome | untested | No actual money transfer is authorized as an incidental probe; use suitable test facilities |
| MARKET-01 | Scoped marketplace/bundle ownership and protected projection boundaries | passed | [Social/marketplace release](backend-section-02-social-marketplace-release-2026-09-27.md), [commerce release](backend-section-05-commerce-release-2026-09-28.md) |
| MARKET-02 | Legacy restore ownership, restore/repurchase deadlock, duplicate revenue reporting | passed | [Lifecycle/reporting release](backend-section-05-mobile-lifecycle-reporting-release-2026-09-30.md) |
| MARKET-03 | Complete web/mobile/credit entitlement lifecycle and file access after revocation | untested | Purchase, restore, refund, deletion, expiry and private-file access matrix; real provider part remains PAY-05 |

## Generation, workflows and media

| ID | Obligation and closure evidence | Status | Evidence / next action |
| --- | --- | --- | --- |
| GEN-01 | Empty/incomplete output callback and durable video/motion polling recovery | passed | [6B release](backend-section-06-empty-output-recovery-release-2026-09-30.md), [6C release](backend-section-06-durable-polling-release-2026-09-30.md) |
| GEN-02 | Grace ordering, lost creation receipt, marker outage and reaper recovery cases | passed | [6D](backend-section-06-grace-recovery-release-2026-09-30.md), [6E](backend-section-06-start-recovery-release-2026-09-30.md), [6F](backend-section-06-marker-recovery-release-2026-10-01.md) releases |
| GEN-03 | Nine actual worker-kill recovery cases | passed | [6G release](backend-section-06-worker-crash-release-2026-10-01.md); limited to those checkpoints |
| GEN-04 | Genuine provider/edge delivery, replay and lost-response behavior | external | Provider-controlled fixture/event evidence remains absent; no paid generation as an incidental probe |
| GEN-05 | Remaining catalog/quote/admission/model verification and generation lifecycle behaviors | untested | Review the 19 assigned API routes and shared quota/cost paths; reuse existing certificates where applicable |
| WORKFLOW-01 | Canvas/child/run-step ownership and start admission fixes | passed | [Workflow ownership](backend-section-02-workflow-release-2026-09-27.md), [RPC admission](backend-section-03-rpc-release-2026-09-27.md) |
| WORKFLOW-02 | Execute, partially fail, restart, retry, approve and cancel runs | untested | Real DB/worker transitions across canvas and template runners |
| WORKFLOW-03 | Billing conservation and idempotency across retry/cancel/recovery | untested | Couple step/run transitions to actual credit ledger fixtures |
| WORKFLOW-04 | Template publication, sharing/import, assistant proposal application and input ownership | untested | Review remaining methods across 31 assigned routes with cross-user and stale-version cases |
| MEDIA-01 | Cleanup retry/concurrency and allocation-failure source cancellation | passed | [6H release](backend-section-06-staging-cleanup-release-2026-10-01.md) |
| MEDIA-02 | Published dead-owner cleanup and inherited reader protection | passed | [6J release](backend-section-06-staging-locks-release-2026-10-01.md); no claim about legacy scratch |
| MEDIA-03 | Sequential crash reclamation under a bounded filesystem | passed | [6K probe](backend-section-06-disk-pressure-2026-10-01.md): five killed owners on 2 MiB tmpfs followed by successful staging |
| MEDIA-04 | Active/inherited reader preservation and failed-write cleanup under disk pressure | passed | [6K probe](backend-section-06-disk-pressure-2026-10-01.md): ENOSPC preserves active bytes; incomplete new staging removed |
| MEDIA-05 | Reach reclaimable files beyond a persistent 128-entry scan prefix | passed | [6L release](backend-section-06-scan-progress-release-2026-10-01.md): real-filesystem regression, cold-process and Linux disk-pressure verification; deployed in PR #256. Inspection remains linear, not time-bounded (MEDIA-07/OPS-03) |
| MEDIA-06 | Concurrent disk admission/backpressure across cooperating writers | passed | [6R release](backend-section-06-capacity-admission-release-2026-10-03.md): shared atomic claims, enforced output ceilings, completed-source accounting, inherited readers, block/inode headroom and DB retry with stable credits; exact-main CI and standard release passed. Uncoordinated writers and production throughput remain outside this bounded certificate |
| MEDIA-07 | Other scratch namespaces and metadata/legacy accumulation policy | failed | [6N reproduction/fix](backend-section-06-media-scratch-2026-10-01.md): all five old namespaces retain bytes after owner death. New leased scratch and cancellation ordering pass real FFmpeg locally and in CI; [deployed in #257](backend-section-06-media-scratch-release-2026-10-01.md). [6S release](backend-section-06-metadata-lifecycle-release-2026-10-03.md) fixes interrupted initialization; verified legacy environment-retirement evidence remains open |
| MEDIA-08 | Upload/import validation, private signed reads, finalization and revocation | untested | Real Storage/HTTP behavior with ownership, expiry, malformed input and replay |
| MEDIA-09 | Deletion/retention correctness and durable input/output recovery | untested | Objects and DB references remain consistent through partial deletion and retry |

## Community, jobs and operations

| ID | Obligation and closure evidence | Status | Evidence / next action |
| --- | --- | --- | --- |
| SOCIAL-01 | Post/feed/search visibility, archive/restore/reveal and pagination | untested | Behavioral method matrix; existing ownership tests do not close visibility propagation |
| SOCIAL-02 | Comments, follows, saves, sharing and notifications across identities/lifecycle | untested | Mutation/retry and cross-user behavior; reuse scoped Section 2 ownership evidence |
| SOCIAL-03 | Moderation/report/block propagation and admin sanctions | untested | Real visibility changes and authorization across readers/clients |
| SOCIAL-04 | Profile, creator and contact surfaces | untested | Remaining method validation, privacy and abuse limits |
| JOB-01 | Scheduler and all 12 jobs: lease contention, expiry, duplicate dispatch and retry | untested | Per-job fixture matrix from the surface map; existing generation cases apply only to that job |
| JOB-02 | Budgets, poison work, retention/reclaim jobs and alert delivery | untested | Prove bounded progress and failures that remain observable |
| JOB-03 | Push registration, preferences, delivery receipts and invalid-token cleanup | untested | Device/provider evidence plus database retry tests |
| JOB-04 | Recorded overdue moderation report | external | Operator review at `/admin/moderation`; no report dismissed by the audit, latest resolution not established |
| OPS-01 | Exact-main Quality, staged/live health and standard release for Section 6J | passed | [6J release evidence](backend-section-06-staging-locks-release-2026-10-01.md); first attempt mismatch preserved |
| OPS-02 | Backup restore and rollback/reconciliation exercises | untested | Isolated restoration with consistency checks and measured recovery; no production restore |
| OPS-03 | Current-build capacity evidence and failure containment | untested | Reconcile [scaling entry point](../scaling-audit.md) with the audited build; local disk probes are not capacity certification |
| OPS-04 | Admin page collectors, telemetry, app-version, CSP and FX methods | untested | Review assigned routes and seven page-only services; protect data and validate failure behavior |

## Completion rule and next sequence

Close the audit only when all failed/untested rows have evidence or an explicit,
recorded scope decision, and external rows have been verified or clearly reported
as unresolved limitations. A green release cannot close unrelated operator or
provider obligations. Passing an inventory check cannot close a behavioral row.

1. MEDIA-05 is closed by the verified Section 6L release. The pass caps successful
   reclamations at 128 and inspects past preserved entries while retaining all
   lock/marker authority checks. Enumeration is linear rather than time-bounded;
   metadata accumulation and latency remain MEDIA-07/OPS-03 obligations.
2. Resolve MEDIA-06/07 by defining capacity and ownership across all scratch
   writers. Section 6M verifies four disk-failure recovery cases without a code
   change; shared admission remains open. The 6K concurrent probe rejects a
   plain free-space preflight as a reservation mechanism.
3. Continue WORKFLOW-02/03/04, then SOCIAL and JOB gates, while finishing MAP-02
   and reconciling earlier domain evidence. Keep provider/operator rows visible.
4. Finish OPS-02/03 and the remaining auth/commerce follow-ups before sign-off.

This ledger is the first explicit closure baseline, not a claim that every
behavior has already been decomposed. MAP-02 remains open to make that limitation
visible. Private generation scripts and raw evidence are under
`.audit-evidence/backend-section-06k/`; preserve them with the existing checkout.
