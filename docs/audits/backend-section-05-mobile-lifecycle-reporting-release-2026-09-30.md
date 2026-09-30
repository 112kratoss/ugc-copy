# Backend Section 5K — mobile lifecycle/reporting release

Status: deployed and verified on `b04ccb46cfecb042b8215e521e0633bc44b9cdf9`.
Updated 2026-09-30 Asia/Kolkata.

[PR #246](https://github.com/112kratoss/ugc-copy/pull/246) fixes legacy bundle
restore ownership, mobile/web checkout lock ordering and duplicate admin revenue
reporting for mobile order copies. The five new concurrency regressions cover
both mobile and web repurchases racing a restore, plus distinct refund/restore
events. New mobile bundle IAPs remain forbidden.

## Build and release

- PR head: `4bc2ca13bc36dcca1d93033b1bd604780321b65f`.
- Merge: `a3d8c25b3801010ac77942a8c6289c893a1ceef4` at 2026-09-29 19:46:15 UTC.
- Release main: `b04ccb46cfecb042b8215e521e0633bc44b9cdf9`.
- [PR Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36620179778)
  and [exact-main Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36666493565)
  passed all four jobs: 6,139 web tests, 2,783 mobile tests, 19 browser tests,
  1,941 SQL assertions and 55 database integration/concurrency cases.
- [Standard production release](https://github.com/112kratoss/ugc-copy/actions/runs/36667235304)
  succeeded at 2026-09-30 04:08:48 UTC, including staged and live protected
  backend-health checks, promotion and exact-build verification.
- Repository migration `20260929191934_reject_conflicting_legacy_bundle_restores.sql`
  maps to production ledger version `20260930040503`.

The merge's push-triggered Quality never appeared across several hours. One
empty retry commit produced release main; `git diff HEAD^ HEAD --exit-code`
confirmed identical trees. That normal push triggered Quality. No workflow gates
changed, and no mobile store release was active before either main update. The
cause of the missing merge trigger remains unconfirmed. No further retry is needed.

## Verification

- Six of nineteen legacy bundle assertions failed before the ownership fix.
  Both mobile and cross-rail restore/repurchase deadlocks were reproduced using
  controlled PostgreSQL lock queues before aligning lock order.
- Two reporting regressions failed before excluding mirrored orders. A real
  PostgreSQL rollback probe verified the literal `mobile_` prefix excludes mobile
  and sandbox copies while retaining web orders and similar nonmatching prefixes.
  Local PostgREST was unavailable; reporting semantics were verified with unit
  tests and the actual SQL filter.
- Final clean replay passed all 1,941 SQL assertions in 90 files. All five new
  lifecycle concurrency cases passed locally and in CI. App/test typechecks,
  targeted lint and migration guards passed without weakening existing tests.
- Sequential production rollback controls passed **20/20 before and after**
  migration. They cover marketplace/credit reconciliation, ordinary web
  settlement, replay and cross-rail ownership. They are regression controls;
  deadlock and legacy-bundle reproduction remain local/CI only.
- Separate cleanup found zero fixture users, profiles, receipts, products,
  orders, credit adjustments and event-history rows. Production probes used
  bounded timeouts and ROLLBACK, no contention, policy bypass or provider charges.
- Both production function digests match clean local replay:
  `complete_marketplace_purchase(text,text)` = `d342e4e4557b6d170ce6f836b1e41d46`;
  `reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)` =
  `1ba17d7267c9337df33aee999efebf10`.
- Only the functions schema fingerprint changed (323 signatures retained).
  Other object classes are unchanged. Security advisors are unchanged at
  **1 INFO / 37 WARN / 0 ERROR** grouped lints, with no added or removed findings.
- Pre-release production inventory had eight credit receipts and no marketplace
  or legacy bundle receipts, so no historical customer repair was indicated.

- Independent live checks: build endpoint 200 with exact SHA `b04ccb46`, feed
  200, unauthorized RevenueCat webhook 401. The authenticated TEST webhook was
  not run because its credential is unavailable locally; provider delivery is
  not certified.

## Separate health signal

Scheduled watchdog run `36656295878` returned HTTP 503 before this release.
Its authenticated response is unavailable locally because OPS_READ_SECRET is
absent. The latest alert-delivery job is skipped because external delivery is
unconfigured; that does not explain the watchdog response. Keep the alert cause
unconfirmed and separate from this fix. The release's staged and live protected backend-health
gates passed; this does not resolve the separate backend-alerts response, which
also includes cost/moderation signals.

Private evidence is under `.audit-evidence/backend-section-05k/`, including
CI/release logs, rollback controls, cleanup, digests, fingerprints and advisors.
Preserve snapshots without blindly committing them. This does not certify actual
provider purchase/refund callbacks or overall backend audit completion.
