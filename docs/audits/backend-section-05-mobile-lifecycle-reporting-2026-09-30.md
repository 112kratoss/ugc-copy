# Backend Section 5K — mobile entitlement lifecycle and reporting

Status: deployed and verified on `b04ccb46cfecb042b8215e521e0633bc44b9cdf9`.
See [release evidence](backend-section-05-mobile-lifecycle-reporting-release-2026-09-30.md).

Three findings were reproduced before their fixes:

1. **Legacy bundle restoration could claim another purchase's access.** After a
   legacy IAP refund and a supported credit-funded repurchase, restoring the IAP
   returned `already_active`, marked the old order paid and receipt/intent active,
   and consumed the restore event while the credit purchase still owned access.
   Six of nineteen real-Postgres assertions failed. Restoration now requires the
   entitlement to belong to the original order, matching the marketplace guard.
   Conflicts abort atomically and remain retryable through the existing webhook.
2. **Marketplace restoration and repurchase could deadlock.** Settlement locked
   the asset before inserting the entitlement; restoration inserted the
   entitlement before updating the asset. A two-session test queued behind an
   asset row reproduced the lock cycle when repurchase acquired the asset first.
   Reconciliation now locks the asset before changing entitlements, matching
   settlement. Cross-rail review reproduced the same lock cycle between a web
   checkout and restoration; web settlement now takes the resource lock too.
   Both arrival orders for mobile and web repurchases, plus concurrent distinct
   refund/restore events, pass while checking access and financial consistency.
3. **Admin revenue repeated noncredit mobile orders.** The mobile rail correctly
   excluded sandbox receipts, but marketplace and bundle rails included their
   mirrored orders. Both reporting regressions failed: real purchases appeared
   twice and sandbox copies appeared as sales. The queries now exclude the
   literal reserved `mobile_` order prefix before the row cap/pagination, while
   preserving ordinary web orders and similar nonmatching prefixes.

## Evidence and boundaries

- Migration: `20260929191934_reject_conflicting_legacy_bundle_restores.sql`.
  Three guarded replacements alter existing reconciliation and web settlement;
  execution remains service-only. There is no customer-data backfill.
- New legacy bundle lifecycle suite: 19 assertions, including conflict rollback,
  credit-funded entitlement ownership, balances, counters and same-event retry.
  Local legacy fixture setup briefly disables only the INSERT policy trigger,
  re-enabling it before reconciliation. New mobile bundle IAPs remain forbidden.
- Five new real concurrency cases run in Quality's database job. The controlled
  ordering reproduces the deadlock without relying on timing luck. Fixtures use
  a distinct catalog tier from sibling tests; all calls settle before cleanup.
- Two reporting regressions exercise returned totals, order count and recent
  orders, including sandbox copies and the literal underscore prefix boundary.
  A local PostgreSQL rollback probe also verifies the actual LIKE filter against
  both order tables: four fixtures per table yield only the two nonmobile rows.
  Local PostgREST was unavailable (this stack runs only the database).
- Clean replay and all 1,941 SQL assertions in 90 files passed on the final migration. Patch context was narrowed to avoid embedding
  unrelated counter-update statements; no existing migration guard was weakened. App/test typechecks and targeted
  lint passed. Focused tests passed. Full web suite: 6,139 passed, with 51 database-dependent cases skipped
  by that invocation and covered separately. Exact-main Quality and the standard release passed; all 20 sequential
  production controls pass, cleanup is empty and both deployed function digests
  match clean local replay.
- Production inventory before release contains eight credit receipts and no
  marketplace or legacy bundle receipts. No customer repair is indicated. No
  production contention test, legacy-policy bypass or real provider charge was
  performed. Local PostgreSQL proves the race and legacy receipt behavior.
- Production migration planner found one correctly ordered migration after
  Section 5J. Private before/after evidence is under
  `.audit-evidence/backend-section-05k/`.

This batch does not certify actual App Store/Play/RevenueCat purchase/refund
callbacks, every marketplace lifecycle path, or overall backend completeness.
