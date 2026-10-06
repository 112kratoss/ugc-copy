# Backend audit completion checklist

Updated 2026-10-06. Current independently checked production:
`b9729ee41f4fc4db1c500bc96283d667eae34847`, including Sections 9A–9O and 10A.
[9O/10A release evidence](backend-section-10-account-deletion-release-2026-10-06.md).
[9M/9N release evidence](backend-section-09-model-verification-release-2026-10-06.md).
[9L release evidence](backend-section-09-feed-interest-release-2026-10-06.md).
[9J/K release evidence](backend-section-09-dispatch-release-2026-10-05.md).
[9I release evidence](backend-section-09-push-summary-release-2026-10-05.md).
[9H release evidence](backend-section-09-push-registration-release-2026-10-05.md).
[9G release evidence](backend-section-09-push-progress-release-2026-10-05.md).
[9F release evidence](backend-section-09-first-send-release-2026-10-05.md).
[9E release evidence](backend-section-09-push-claims-release-2026-10-05.md).
[9A–9D release evidence](backend-section-09-jobs-release-2026-10-05.md).
[8H release evidence](backend-section-08-share-controls-release-2026-10-05.md).
Exact-main Quality, standard release, function digests and live checks pass; see
[save-counter release and repair](backend-section-08-save-counters-release-2026-10-04.md).
The nine historical count mismatches were reconciled; independent readback is zero.
[8C #338 release is verified](backend-section-08-follow-block-release-2026-10-04.md). 8D reproduces comment-thread
reads across a creator block; eight real transport and 46 focused cases pass
after the fix; [8D release is verified](backend-section-08-comment-lifecycle-release-2026-10-04.md). Broader social behavior coverage remains open.
Surface inventory baseline remains `5934bd7d`; Section 6L changed no surfaces.

This is the closure ledger for the audit, replacing section numbers as a progress
measure. A row is a bounded obligation, not a subsystem percentage. The rows have
unequal effort and risk. Do not turn their pass count into a percentage of backend
safety or an ETA. New findings attach to these obligations; changes in scope must
be recorded explicitly instead of silently adding another lettered batch.

Current ledger: **53 obligations — 24 passed, 25 untested, 2 failed, 2 external**.
These counts describe this scoped checklist, not a percentage of the backend.
WORKFLOW-02 and WORKFLOW-04 remain untested after their scoped fixes shipped.
SOCIAL-01/02/04 return to untested after the verified 8F/8G releases.
DB-04 passes for the current empty Realtime publication; enabling table streams or application channels requires reopening it.
SOCIAL-03 returns to untested after the scoped 8D release. MEDIA-07 remains failed
for legacy retirement.
No new obligation was added; these fixes do not complete the broader matrices.

Status meanings: **passed** has evidence for the stated scope; **failed** has a
reproduction and remains open; **untested** lacks complete evidence for this
obligation (it may have earlier partial tests); **external** needs provider,
operator, device or environment evidence that local fixtures cannot supply.

The [surface map](backend-audit-surface-map-2026-10-01.json) records every current
API route and `*service.ts` file, the isolated database's public functions and
relations, and all registered jobs. File-level static reachability deliberately
over-approximates callers. Seven services without API callers have reviewed page
callers; eight indirect RPC sites have reviewed function names. The [October 4 caller reconciliation](backend-audit-caller-reconciliation-2026-10-04.md)
classifies the earlier 152 no-JS-caller functions as 85 catalog-bound, nine with
source/operator callers, 34 with reviewed SQL calls and 24 without a current caller
located. None is presumed unused; behavior and compatibility remain MAP-02/DB-03 work. The local
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
| MAP-02 | Reconcile method-level behaviors, non-API entrypoints, SQL/trigger callers, mobile direct access, edge and operational scripts to this ledger | untested | [Explicit HTTP method map](backend-audit-http-method-map-2026-10-04.md) records 162 routes/186 methods, including 35 social routes/45 methods. Static paths remain scheduling evidence; [Caller reconciliation](backend-audit-caller-reconciliation-2026-10-04.md) reviews the earlier 152 entries; remaining entrypoints, method behavior and table mutation/read paths stay open |

## Authentication and database

| ID | Obligation and closure evidence | Status | Evidence / next action |
| --- | --- | --- | --- |
| AUTH-01 | Guest/profile, ban/session/lifecycle and signed-balance merge regressions | passed | [Section 1 report](backend-section-01-auth-2026-09-26.md) and the current handoff, including controlled live identity and merge checks; historical balances were not rewritten |
| AUTH-02 | Previously exercised native Apple, Chrome web and admin login/logout flows | passed | [Current handoff](backend-audit-handoff.md); this does not certify every provider or recovery flow |
| AUTH-03 | Disposable-account deletion through provider revocation, cleanup failure and restart | untested | [10A](backend-section-10-account-deletion-2026-10-06.md): twelve actual local Auth/Storage/SQL controls cover owner cleanup, route identity/reauthentication, buyer file retention, copy/mapping failures and SIGKILL recovery. [10B](backend-section-10-account-deletion-identities-2026-10-06.md) adds ten real controls for linked guests, all eight owner buckets, template/public/private post namespaces, durable claim history and a live worker after actual lease/grace expiry (22 total). [10C](backend-section-10-account-deletion-references-2026-10-06.md) adds five real legacy generation-reference retention/failure-retry controls (27 total). [10D](backend-section-10-account-deletion-retained-access-2026-10-06.md) adds six structured-file/publication and retained-read/retraction/signature/expiry controls (33 total). Cash refund after creator deletion, other reference variants and real provider revocation stay open |
| AUTH-04 | Mobile Google deep-link completion and remaining password/email/session recovery flows | untested | Real client/provider execution; reconcile earlier evidence before repeating checks |
| AUTH-05 | JWT key rotation/fallback and sessionless-token compatibility | untested | Controlled rotation environment and explicit legacy compatibility decision |
| AUTH-06 | CAPTCHA/rate configuration rollout compatible with installed clients | untested | Hosted configuration plus old/new client behavior, not configuration presence alone |
| DB-01 | Scoped workflow parent, financial, notification, social and projection ownership fixes | passed | [Section 2 ledger](backend-section-02-tables-2026-09-27.md) and its linked release records |
| DB-02 | Identified client-callable workflow RPC admission bypass | passed | [Section 3 release](backend-section-03-rpc-release-2026-09-27.md) |
| DB-03 | Remaining invoker/definer behavior, constraints and trigger invariants across mapped objects | untested | [Invoker helper review](backend-section-08-invoker-helper-review-2026-10-05.md) finds no further defect in explicit public-qualified calls; immutable revision direct/cascade controls pass. Remaining SQL-only call chains and positive/negative role and ownership fixtures stay open |
| DB-04 | Realtime visibility and revocation behavior | passed | [Current configuration evidence](backend-realtime-exposure-2026-10-05.md): production and local publications contain zero tables, no application channel consumer/producer; actual local owner/other/anonymous sockets across profile changes and deletion receive no row events. Reopen before enabling streams/channels; no claim of future RLS/revocation semantics |
| DB-05 | Deferred compatibility grant removal | untested | Verify supported clients before the separate rollout; do not remove grants merely to close this row |

## Payments, marketplace and payouts

| ID | Obligation and closure evidence | Status | Evidence / next action |
| --- | --- | --- | --- |
| PAY-01 | Credit grant identity/idempotency regressions | passed | [Credit grant release](backend-section-05-credit-grants-release-2026-09-28.md) |
| PAY-02 | Receipt/event identity and reversal target binding regressions | passed | [Receipt release](backend-section-05-receipt-identity-release-2026-09-29.md), [binding release](backend-section-05-credit-event-binding-release-2026-09-29.md), [event history](backend-section-05-mobile-event-history-release-2026-09-29.md) |
| PAY-03 | Reproduced refund/restore ordering and debt cases | passed | [Refund release](backend-section-05-refund-ordering-release-2026-09-28.md); the full event lifecycle matrix is PAY-04 |
| PAY-04 | Remaining credit, referral, refund/dispute/restore and reconciliation combinations | failed | [10E](backend-section-10-detached-cash-refunds-2026-10-06.md) reproduces detached refund rejection/deletion deadlock; merged #376 awaits release verification. [10F](backend-section-10-deletion-freeze-refunds-2026-10-06.md) fixes reproduced refunds frozen during retrying deletion locally; release remains. Broader orderings stay open. |
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
| WORKFLOW-02 | Execute, partially fail, restart, retry, approve and cancel runs | untested | [7E](backend-section-07-canvas-persistence-2026-10-03.md) reproduces accepted-task loss from a failed link write; [7F](backend-section-07-atomic-approval-2026-10-03.md) reproduces stranded partial approval. Both are released: [7E](backend-section-07-canvas-persistence-release-2026-10-03.md), [7F](backend-section-07-atomic-approval-release-2026-10-03.md). Template completion/worker death evidence is in [7C/D](backend-section-07-completion-recovery-release-2026-10-03.md); broader canvas recovery remains open |
| WORKFLOW-03 | Billing conservation and idempotency across retry/cancel/recovery | untested | 7A/7C/D template SQL evidence and 7E/7F real canvas image/video holds, refunds, retries and duplicate settlement are recorded; remaining interruption and provider/Storage cases stay open |
| WORKFLOW-04 | Template publication, sharing/import, assistant proposal application and input ownership | untested | [7G](backend-section-07-assistant-discard-2026-10-03.md) reproduces applied-state overwrite and false discard success; [7G release verified](backend-section-07-assistant-discard-release-2026-10-04.md). [7H](backend-section-07-canvas-authoring-2026-10-03.md) also reproduces stale restore overwrite and publication revision regression; [7H release verified](backend-section-07-canvas-authoring-release-2026-10-04.md). [7I](backend-section-07-share-import-count-2026-10-04.md) reproduces two imported copies counted as one; eight SQL cases pass and [7I is released](backend-section-07-share-import-release-2026-10-04.md). [7J](backend-section-07-assistant-apply-2026-10-04.md) adds ten permanent apply controls; [7J release verified](backend-section-07-assistant-apply-release-2026-10-04.md). [7K](backend-section-07-template-inputs-2026-10-04.md) reproduces concurrent finalization orphaning; seven real local Storage/HTTP and five service controls pass; [7K release verified](backend-section-07-template-inputs-release-2026-10-04.md). [7B publication fix released](backend-section-07-publication-release-2026-10-03.md); [36-method inventory](backend-section-07-method-matrix-2026-10-03.md) records remaining actual Storage, cross-user, stale-version and authoring cases |
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
| SOCIAL-01 | Post/feed/search visibility, archive/restore/reveal and pagination | untested | [8F restore](backend-section-08-post-restore-2026-10-05.md): service-role quality-helper permission and delayed archive overwrite reproduced; candidate passes four actual PostgREST cases. [8F release verified](backend-section-08-post-restore-release-2026-10-05.md), including five production rollback controls and the exact grant delta; remaining visibility matrix stays open |
| SOCIAL-02 | Comments, follows, saves, sharing and notifications across identities/lifecycle | untested | [8G malformed input](backend-section-08-social-inputs-2026-10-05.md) reproduces share/save/remix 500s; [8G release verified](backend-section-08-social-inputs-release-2026-10-05.md).  [8A](backend-section-08-follow-retries-2026-10-04.md) reproduces concurrent follow retry returning 500 despite the saved intent; three actual PostgREST controls pass and [8A release is verified](backend-section-08-follow-retries-release-2026-10-04.md). [8B](backend-section-08-save-counters-2026-10-04.md) reproduces save-count drift after deletion/concurrent toggle; 12 SQL controls pass and [8B release/repair is verified](backend-section-08-save-counters-release-2026-10-04.md). [8D](backend-section-08-comment-lifecycle-2026-10-04.md) adds 11 SQL lifecycle controls. [8H share controls](backend-section-08-share-boundaries-2026-10-05.md): thirteen actual PostgREST/SQL cases and ten actual HTTP assertions pass. Remaining mutation/retry and cross-user behavior; reuse scoped Section 2 ownership evidence |
| SOCIAL-03 | Moderation/report/block propagation and admin sanctions | untested | [8C](backend-section-08-follow-block-race-2026-10-04.md) reproduces an uncommitted follow surviving a block; six SQL cases pass after serialization; [8C release is verified](backend-section-08-follow-block-release-2026-10-04.md). [8D](backend-section-08-comment-lifecycle-2026-10-04.md) reproduces whole-thread reads across creator blocks; [8D release is verified](backend-section-08-comment-lifecycle-release-2026-10-04.md). Remaining moderation and visibility behavior stays open |
| SOCIAL-04 | Profile, creator and contact surfaces | untested | [8G profile sharing](backend-section-08-social-inputs-2026-10-05.md) reproduces malformed/null request 500s; [8G release verified](backend-section-08-social-inputs-release-2026-10-05.md).  [8E profile/contact](backend-section-08-profile-contact-2026-10-04.md): malformed/null profile requests reproduce HTTP 500; candidate returns 400, twelve actual HTTP and seven PostgREST checks pass. [8E release verified](backend-section-08-profile-contact-release-2026-10-05.md); [13 creator HTTP controls](backend-section-08-creator-visibility-2026-10-04.md) pass. Profile media, share events, request byte limits and remaining method behavior stay open |
| JOB-01 | Scheduler and all 12 jobs: lease contention, expiry, duplicate dispatch and retry | untested | [Shared lease controls](backend-section-09-job-locks-2026-10-05.md): seven real PostgREST/SQL cases, including SIGKILL and real expiry, pass. [Twelve-job matrix](backend-job-behavior-matrix-2026-10-05.md) records remaining entrypoints and behavior. [9J alert-job controls](backend-section-09-alert-delivery-2026-10-05.md) add eleven actual HTTP/DB cases including worker death. [9M feed controls](backend-section-09-feed-maintenance-recovery-2026-10-05.md) add 17 real phase/retry/managed-lease controls. Other per-job fixtures still required; existing generation cases apply only to that job |
| JOB-02 | Budgets, poison work, retention/reclaim jobs and alert delivery | untested | [9B retention reporting](backend-section-09-retention-failures-2026-10-05.md): eleven baseline regressions reproduce silent RPC errors and interrupted supplementary progress. Local fix passes 39 focused cases and actual durable job-summary persistence; [release verified](backend-section-09-jobs-release-2026-10-05.md). [9G push starvation](backend-section-09-push-poison-progress-2026-10-05.md) reproduces three per-record failures and a full 100-row poison batch blocking healthy work and retention repeatedly. Scan/failure-isolation passes eight actual controls; [9G release verified](backend-section-09-push-progress-release-2026-10-05.md). [9L](backend-section-09-feed-interest-progress-2026-10-05.md) reproduces empty interest results starving later users; marker fix passes 19 SQL controls and a full 1,000-user empty batch; [9L release verified](backend-section-09-feed-interest-release-2026-10-06.md). [9N](backend-section-09-model-verification-2026-10-06.md) reproduces sparse-model verification history loss; lookup fix passes 14 actual controls and 15 SQL assertions; [9N release verified](backend-section-09-model-verification-release-2026-10-06.md). [9O](backend-section-09-model-verification-recovery-2026-10-06.md) adds five actual managed-job failure/overlap/expiry/death controls (19 total). Broader bounded-progress matrix remains open |
| JOB-03 | Push registration, preferences, delivery receipts and invalid-token cleanup | untested | [9C receipt recovery](backend-section-09-push-receipts-2026-10-05.md): four actual PostgREST cases reproduce ignored writes/stranded token retirement; local fix and retry controls pass. [9D retry persistence](backend-section-09-push-retries-2026-10-05.md) adds six actual failing/passing cases; accepted-ticket write failure still duplicates and undercounts attempts on retry. [9A–9D release verified](backend-section-09-jobs-release-2026-10-05.md). [9E retry claims released and verified](backend-section-09-push-claims-release-2026-10-05.md). [9F initial send released and verified](backend-section-09-first-send-release-2026-10-05.md); [9H concurrent registration](backend-section-09-push-registration-race-2026-10-05.md) reproduces two successes leaving both device tokens inactive; the atomic candidate passes seven real Auth/PostgREST cases and 22 SQL controls; [9K](backend-section-09-push-preferences-2026-10-05.md) adds seven real preference/retirement controls. [Registration release verified](backend-section-09-push-registration-release-2026-10-05.md); [summary observability release verified](backend-section-09-push-summary-release-2026-10-05.md). Broader device/aggregation/history evidence remains open |
| JOB-04 | Recorded overdue moderation report | passed | [Read-only follow-up](backend-section-08-moderation-queue-followup-2026-10-04.md): original report has a reviewer and October 1 dismissal timestamp; both queues empty October 4; watchdog passes. Audit made no report mutation |
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
2. MEDIA-06 passes its cooperating-writer scope under the 6R release. MEDIA-07
   still requires verified legacy environment retirement after the 6S metadata
   fix; unknown legacy files must not be deleted speculatively.
3. Continue WORKFLOW-02/03/04, then SOCIAL and JOB gates, while finishing MAP-02
   and reconciling earlier domain evidence. Keep provider/operator rows visible.
4. Finish OPS-02/03 and the remaining auth/commerce follow-ups before sign-off.

This ledger is the first explicit closure baseline, not a claim that every
behavior has already been decomposed. MAP-02 remains open to make that limitation
visible. Private generation scripts and raw evidence are under
`.audit-evidence/backend-section-06k/`; preserve them with the existing checkout.
