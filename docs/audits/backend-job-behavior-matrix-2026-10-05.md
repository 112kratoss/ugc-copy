# Backend job behavior matrix — October 5, 2026

This maps all twelve registry entries to their business work and remaining audit
obligations. It is a scheduling inventory, not a pass certificate. Source baseline
is `25b75dbb` (pending 9C candidate). All use the shared managed-job wrapper with
an 840-second lease and 300-second route limit. Seven actual lease tests cover
contention, release, failure and killed-holder expiry; they do not prove each
job's state transitions or fencing after expiry.

| Registry job | Dispatch / cadence | Business entrypoint and bounded work | Evidence / remaining behavior |
| --- | --- | --- | --- |
| account-deletion-resweeps | Scheduler / 10 min | `processAccountDeletionCleanup`, default batch 10 | [10A](backend-section-10-account-deletion-2026-10-06.md) adds twelve actual local Auth/Storage/SQL controls including route identity/reauthentication, buyer file retention, copy/mapping failures and SIGKILL recovery. Linked identities, remaining namespaces/reference variants and provider revocation remain AUTH-03; no whole-job sign-off |
| backend-alert-delivery | Scheduler / 10 min | `deliverBackendAlerts`, one collected payload and timed HTTP request | [9J](backend-section-09-alert-delivery-2026-10-05.md): eleven actual HTTP/PostgREST/SQL controls cover no-work, collector failure, rejection, lost acknowledgement, real timeout, overlap, real lease expiry and SIGKILL. External delivery and overlong-holder fencing are not certified |
| feed-maintenance | Scheduler / hourly :20 | `maintainFeedPersonalization`, aggregate limits 1,000; daily rollup before bounded prune | [9L](backend-section-09-feed-interest-progress-2026-10-05.md) [release verified](backend-section-09-feed-interest-release-2026-10-06.md) for empty-result starvation. [9M](backend-section-09-feed-maintenance-recovery-2026-10-05.md): 17 actual controls cover all six phase failures, six SIGKILL checkpoints, lost rollup acknowledgement, managed overlap/failure records, abandoned expiry and managed SIGKILL/expiry recovery. Actual cache effects, full lease fencing and remaining retention bounds stay open |
| generation-completions | Dedicated / 10 min | Completion queue, output imports, stalled generations and associated workflow/template recovery | Sections 6B–6G/7C–7F provide database and worker-death evidence at named checkpoints; genuine provider/edge delivery remains GEN-04; no whole-job sign-off |
| generation-model-verification | Scheduler / daily 00:30 UTC | `verifyPublishedGenerationModels`, per-request timeout 8 s | [9N](backend-section-09-model-verification-2026-10-06.md) reproduces lost sparse-model history; local per-model lookup fix passes 14 actual HTTP/DB and 15 SQL controls. [Release verified](backend-section-09-model-verification-release-2026-10-06.md). [9O](backend-section-09-model-verification-recovery-2026-10-06.md) adds five managed-job controls for failure/overlap, abandoned expiry and SIGKILL before/after snapshot commit (19 actual cases total). Model-set bounds, overlong live holders and real provider behavior remain open |
| media-preview-repair | Dedicated / 10 min | `repairMediaPreviews`, rendition batch 12 / 60 s; additional poster/legacy passes | Real FFmpeg scratch tests apply to filesystem behavior; object persistence, poison work and restart/duplicates remain MEDIA-08/09 and JOB-02 |
| media-upload-reclaim | Scheduler / daily 00:10 UTC | Missing generation inputs repaired before abandoned upload reclaim, batch 500 | Partial repair blocks reclaim by design; actual Storage interruption and reference-preservation matrix remain open |
| mobile-push-receipts | Scheduler / 10 min | Receipt scans, unsent retry, notification retention | 9C reproduces/repairs receipt write and token-retirement failures with actual DB state; send-retry persistence and genuine installed-device/provider delivery still open |
| operational-data-retention | Scheduler / daily 00:50 UTC | Main per-table capped prune, supplementary prunes, expired-upload proof then bookkeeping prune | Existing SQL retention tests plus 9B durable failure reporting; remaining lock/poison-work progress, all retention boundaries and actual Storage failure combinations stay open |
| referral-reward-reconciliation | Scheduler / hourly :40 | `reconcileReferralPurchaseRewards`, batch 100 / concurrency 10 | Unit reconciliation tests and earlier commerce settlement evidence; retry between settlement and notification, provider identity combinations and poison work remain PAY-04/JOB-02 |
| showcase-media-revocations | Scheduler / hourly :30 | Revocation batch 50 with retry backoff plus uploaded-media maintenance | SQL-trigger enqueue and unit revocation evidence are partial; actual failed Storage deletion/retry and renewed-reference races remain MEDIA-09 |
| workflow-run-steps | Scheduler / 10 min | Step batch 10, stalled workflow recovery plus template processing | Sections 7A–7K cover named SQL/Storage/recovery defects; remaining canvas failure/cancellation/billing cases remain WORKFLOW-02/03/04 |

The registry's due-window evaluator dispatches only scheduler entries from the
shared route; dedicated media jobs are separate Vercel cron invocations. The
actual configured total is 432 cron invocations/day (144 scheduler + 144 generation
+ 144 preview), within the declared 456 budget. An older source comment's 312
figure uses an hourly preview assumption and is not current configuration evidence.
No runtime budget is changed by this document.

For each open row, completion still requires applicable no-work, active contention,
expired-holder recovery, duplicate/retry after durable writes, terminal-versus-
retryable failure, bounded progress past poison work, and observable outcomes.
Use local isolated DB/Storage/provider simulators for destructive and contention
cases; production is limited to authorized bounded rollback/read-only evidence.
