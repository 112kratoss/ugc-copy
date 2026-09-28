# Section 5B — credit refund and dispute ordering

Status: four accounting defects reproduced and fixed locally; release pending.
Scope: Razorpay credit purchases. Marketplace/resource entitlements, mobile
RevenueCat settlement, referral policy certification and real provider delivery
remain separate batches.

## Reproduction

The actual `processRazorpayWebhookForRoute` handler was driven against the local
Postgres settlement functions, with every scenario in a rolled-back transaction.
No mocked balance arithmetic was used. All four tests failed before the fix:

| Sequence (100-credit purchase) | Previous balance | Correct balance |
| --- | ---: | ---: |
| 30-credit dispute won, then delayed open | 70 | 100 |
| Open 30, refund 50, won with old zero-refund snapshot | 80 | 50 |
| Open 30, refund 20 | 70 | 50 |
| Concurrent distinct disputes of 20 and 30 | 70 | 50 |

The handler computed aggregate reversal targets from an unlocked transaction
snapshot. The generic adjustment RPC could enforce monotonic reverse/restore
operations, but could not tell refunds apart from individual disputes. An old
won event could therefore restore refund credits, and a later reverse event
could reopen a won dispute. The generic helper also accepted every RPC status
as success, including unresolved conflicts.

## Change

`reconcile_razorpay_credit_source` locks the purchase first, stores each refund
or dispute source, and calculates the total under that lock. Refund snapshots
only increase. Dispute amounts are immutable; a won flag remains set even if an
older open/lost/closed event arrives later. The target is the highest refund
snapshot plus outstanding disputes, capped at the purchase amount. Existing
atomic credit/referral reconciliation and its immutable adjustment ledger remain
the money-changing path. Pre-grant reversals/restores remain bookkeeping-only;
spent credits can become debt rather than silently escaping a refund.

The source table has RLS and no client grants. The service role can inspect it,
but writes go through the privileged RPC. Source IDs cannot change transaction,
payment or dispute amount. Conflicts and ambiguous legacy state return an
unresolved status; the webhook responds 500 and records existing durable payment
failure telemetry instead of claiming success. Notifications use the actual
net adjustment direction, including a won event with a newer refund snapshot.

Provider semantics checked against the current official [refund payloads](https://razorpay.com/docs/webhooks/refunds)
and [dispute payloads](https://razorpay.com/docs/webhooks/disputes). These contain
payment refund snapshots and separate dispute amounts. This change preserves
the existing product policy of withholding disputed credits until won; it does
not change settlement into cash accounting based on `amount_deducted`.

## Validation

- Four real handler + database regressions: failed before, passed after.
  This suite now runs in the database CI job with `SUPABASE_TEST_DB_URL`; it is
  explicitly skipped in the web-only job. Connections are restricted to localhost.
- 52 new SQL assertions: mixed refund/dispute ordering, caps, two disputes,
  terminal wins, replays, debt, pre-grant behavior, malformed inputs, source and
  payment conflicts, legacy state and role permissions.
- Clean replay: 258 migrations; full database suite 82 files / 1,735 assertions.
- Focused unit tests: 22 files / 139 tests; four integration cases run separately.
  Application/test type checks and changed-file lint passed.
- Separate local connections: 40 competing open calls produced ten source rows
  and 30 duplicates; balance moved 100 -> 50. Then 41 competing won/delayed-open/
  refund calls ended at 80 credits with exactly 2,000 subunits refunded. Fixtures
  were removed by resetting only the dedicated audit database.
- `scripts/ops/verify-razorpay-credit-sources.sql` contains the 52-assertion
  production probe with temporary invoker helpers and a final rollback; its local
  rehearsal passed. No provider calls or real charges are made by the probe.

## Rollout and legacy review

Production's credit adjustment ledger contained zero rows at preflight, so no
historical conversion is needed. A payment touched by the old callback handler
while the deployment switches versions will be flagged if it has legacy ledger
entries. Never automatically interpret a legacy cumulative amount as either a
refund or a dispute: the distinction has already been lost.

For `legacy_adjustment_requires_review` or `source_conflict`, use existing
payment failure telemetry to locate the payment, inspect its provider refund and
dispute history and the immutable local adjustment trail, and reconcile through
a separately reviewed transaction. Do not clear source rows or force a webhook
200 merely to stop retries. The retained old RPC remains necessary for migration
compatibility and existing direct refund helpers; the new webhook path detects
legacy entries rather than mixing the two accounting models.

This release changes both SQL and callback code: deploy the migration first,
then the matching app through the normal production release workflow. A rollback
of app code to the legacy callback requires accounting review before processing
further credit adjustments; reverting code alone does not restore source state.

See [Section 5A release evidence](backend-section-05-credit-grants-release-2026-09-28.md)
for the preceding credit-grant batch.
