# Sections 5D/5E — bundle refund and mobile grant release

PR [#237](https://github.com/112kratoss/ugc-copy/pull/237) merged as `6bd6a484f48710eeb81bb0ac9b29799185d5e20e`.

- PR Quality [36398405529](https://github.com/112kratoss/ugc-copy/actions/runs/36398405529): passed all four jobs. 6,015 web tests, 2,738 mobile tests, 19 browser smoke tests, 1,812 SQL assertions, 2 existing credit concurrency tests, 5 new cash/mobile concurrency tests and 4 real Razorpay handler/database tests.
- Exact-main Quality [36400847516](https://github.com/112kratoss/ugc-copy/actions/runs/36400847516): database job failed on simultaneous mobile purchase replay. Production deployment was blocked.
- Production release and live probes: pending.

This release repairs the mobile grant regression introduced by the earlier Razorpay-only `add_credits` guard. It also resolves the reproduced bundle capture/refund deadlock. See the [mobile regression evidence](backend-section-05-mobile-credit-grant-2026-09-28.md) and [bundle concurrency evidence](backend-section-05-commerce-concurrency-2026-09-28.md).

The first PR run caught an overbroad migration guard that mistook deferred SQL inside an RPC definition for immediate stored-content rewrites. The guard now excludes function definitions while still checking top-level statements and immediate DO blocks; a dedicated test covers those distinctions. The final PR run passed.

Production preflight found no existing test users/store IDs for the probes and confirmed the expected 500-credit catalog product. All production mutations below must remain fixture-only and rolled back. Provider charging/refunds and successful webhook delivery are not part of the SQL probes.

## Follow-up: serialize mobile settlement identities

The main CI database test reproduced an additional race: after the initial store-transaction lookup misses, a competing call can commit before the external-order check. Two of eight identical requests returned `transaction_conflict` instead of `already_processed`; only one credit grant occurred. This was a response/idempotency defect, not a duplicate-credit grant.

Migration `20260928090559_serialize_mobile_settlement_identity.sql` acquires transaction-scoped advisory locks on the store transaction and external order, in that order, before the first ledger lookup. Store IDs are locked globally because the ledger makes them globally unique. Existing identity checks, the repaired credit grant, and service-only execution remain in place. A guarded replacement fails if the expected function definition differs.

The integration regression now runs 24 rounds of eight independent database connections: 12 same-owner replays and 12 competing-owner attempts. Every round requires exactly one completed grant, one ledger entry, one intent, and 500 aggregate credits; same-owner replays must all succeed idempotently. The CI failure is the pre-fix reproduction; the expanded local run before the patch did not reproduce this timing-dependent failure.

Local validation after the patch: all 24 concurrency rounds and the migration guard passed. Clean replay and the full SQL suite passed (1,812 assertions). Production and provider-level validation remain pending until the follow-up passes both PR and exact-main Quality and the standard release workflow.
