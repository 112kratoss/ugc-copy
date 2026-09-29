# Backend Section 5I — credit event binding release

Status: deployed and verified. Production release completed 2026-09-29 15:35:45 UTC.

- PR: https://github.com/112kratoss/ugc-copy/pull/244.
- Merged main: `17e47edc303588abd4fd3ad18b780378e7b2ba1c`.
- [PR Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36588396734) passed all four jobs.
- [Exact-main Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36589512045) passed all four jobs.
- [Production release](https://github.com/112kratoss/ugc-copy/actions/runs/36590989396) passed staged health, promotion and live verification.
- The merged main also includes the independent Android OTA target record `cdf31199`; this audit did not edit that record.
- Migration: `20260929150256_bind_credit_adjustment_events.sql`; production ledger version `20260929153307` (`bind_credit_adjustment_events`).
- Local validation: 6,135 web tests, 1,885 SQL assertions, 34 focused
  adapter/migration/database cases, test typecheck, targeted lint and diff check.
- Baseline: six SQL regressions (including one added during review), four
  database-backed HTTP regressions and six adapter regressions reproduced.
- Production rollback probe: 7/11 checks passed before the fix; four incorrect
  outcomes reproduced. Separate cleanup found zero users, transactions or receipts.
- Read-only production inventory: zero RevenueCat adjustment rows, zero detected
  cross-transaction event bindings and zero revoked credit receipts without a
  full reversal. No historical customer data repair performed.
- Production migration planner: one correctly ordered pending migration.

Post-release verification:

- All 11 production rollback checks passed (7/11 before the fix). Conflicting
  events leave the other receipt and transaction unconsumed; a corrected refund
  still reverses its credits. Separate cleanup found zero fixture users,
  profiles, transactions, receipts, intents or credit adjustments.
- All four function digests match clean local replay:
  - `reconcile_credit_purchase_adjustment`: `e2e3ee24f4b60ce2fffe0ecd50532208`.
  - `reconcile_mobile_credit_purchase_adjustment`: `8f3be1793b23ccd95f2cf8a3dff2aa45`.
  - `reconcile_mobile_purchase_adjustment`: `207156a3dcca5e3a2df5fc3673733f63`.
  - `reconcile_razorpay_credit_purchase_adjustment`: `f9deedf9fc6103a63fcd03b1ce3fcbc1`.
- Only the functions schema fingerprint changed; the other 15 classes are
  unchanged. Security advisors remain 1 INFO / 37 WARN / 0 ERROR.
- Independent live SHA and feed requests returned 200; unauthorized RevenueCat
  webhook returned 401. The authenticated no-op webhook was not run because its
  credential was unavailable locally. Actual provider delivery is not certified.
- Exact-main Quality passed all four jobs, including 1,885 SQL assertions and
  19 browser tests. PR Quality also passed 6,135 web tests, 2,783 mobile tests
  and 47 database integration/concurrency cases (2 + 27 + 18).

Evidence is under `.audit-evidence/backend-section-05i/`; preserve it privately.
Noncredit mobile event binding, marketplace concurrency, reporting and the audit
coverage tracker remain open. No overall backend sign-off is implied.
