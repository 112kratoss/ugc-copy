# Sections 5D/5E — bundle refund and mobile grant release

PR [#237](https://github.com/112kratoss/ugc-copy/pull/237) merged as `6bd6a484f48710eeb81bb0ac9b29799185d5e20e`.

- PR Quality [36398405529](https://github.com/112kratoss/ugc-copy/actions/runs/36398405529): passed all four jobs. 6,015 web tests, 2,738 mobile tests, 19 browser smoke tests, 1,812 SQL assertions, 2 existing credit concurrency tests, 5 new cash/mobile concurrency tests and 4 real Razorpay handler/database tests.
- Exact-main Quality [36400847516](https://github.com/112kratoss/ugc-copy/actions/runs/36400847516): database job failed on simultaneous mobile purchase replay. Production deployment was blocked.
- Follow-up PR #238, production release, and live probes: passed; see final verification below.

This release repairs the mobile grant regression introduced by the earlier Razorpay-only `add_credits` guard. It also resolves the reproduced bundle capture/refund deadlock. See the [mobile regression evidence](backend-section-05-mobile-credit-grant-2026-09-28.md) and [bundle concurrency evidence](backend-section-05-commerce-concurrency-2026-09-28.md).

The first PR run caught an overbroad migration guard that mistook deferred SQL inside an RPC definition for immediate stored-content rewrites. The guard now excludes function definitions while still checking top-level statements and immediate DO blocks; a dedicated test covers those distinctions. The final PR run passed.

Production preflight found no existing test users/store IDs for the probes and confirmed the expected 500-credit catalog product. All production mutations below must remain fixture-only and rolled back. Provider charging/refunds and successful webhook delivery are not part of the SQL probes.

## Follow-up: serialize mobile settlement identities

The main CI database test reproduced an additional race: after the initial store-transaction lookup misses, a competing call can commit before the external-order check. Two of eight identical requests returned `transaction_conflict` instead of `already_processed`; only one credit grant occurred. This was a response/idempotency defect, not a duplicate-credit grant.

Migration `20260928090559_serialize_mobile_settlement_identity.sql` acquires transaction-scoped advisory locks on the store transaction and external order, in that order, before the first ledger lookup. Store IDs are locked globally because the ledger makes them globally unique. Existing identity checks, the repaired credit grant, and service-only execution remain in place. A guarded replacement fails if the expected function definition differs.

The integration regression now runs 24 rounds of eight independent database connections: 12 same-owner replays and 12 competing-owner attempts. Every round requires exactly one completed grant, one ledger entry, one intent, and 500 aggregate credits; same-owner replays must all succeed idempotently. The CI failure is the pre-fix reproduction; the expanded local run before the patch did not reproduce this timing-dependent failure.

Local validation after the patch: all 24 concurrency rounds and the migration guard passed. Clean replay and the full SQL suite passed (1,812 assertions). The follow-up passed PR and exact-main Quality and the standard production release. Live database and HTTP verification is recorded below; provider charging/delivery remains a separate coverage limit.

## Final production verification — 2026-09-29

PR [#238](https://github.com/112kratoss/ugc-copy/pull/238) merged as `0ff0edd326974c2cb6f0bdbda8c06772dcf6b9bf`. PR Quality [36401856496](https://github.com/112kratoss/ugc-copy/actions/runs/36401856496) and exact-main Quality [36402955385](https://github.com/112kratoss/ugc-copy/actions/runs/36402955385) passed all four jobs: 6,016 web tests, 2,738 mobile tests, 19 browser tests, 1,812 SQL assertions, 2 credit concurrency tests, 27 cash/mobile concurrency cases and 4 real Razorpay handler/database tests. The 31 cases skipped in the ordinary web job ran successfully in the mandatory database job with an explicit database URL.

Production release [36403709392](https://github.com/112kratoss/ugc-copy/actions/runs/36403709392) succeeded at 2026-09-28 09:31:54 UTC, including migration, stage, health checks and promotion. The ledger confirms:

| Migration | Production ledger version |
| --- | --- |
| serialize_bundle_cash_refunds | 20260928092849 |
| restore_verified_mobile_credit_settlement | 20260928092853 |
| serialize_mobile_settlement_identity | 20260928092856 |

Verification resumed after later releases. The observed live build was `26c017bdb696d1620d097fee9d0d4eb2a0f00274`, which descends from #238. Both shipped function definitions still exactly match the clean local replay:

- `complete_mobile_purchase`: MD5 `71e706c0deb931cff96233c1035280d6`.
- `reconcile_post_resource_cash_adjustment`: MD5 `49e968e2fcc9c1f567706a555806134e`.

Production verification at approximately 2026-09-29 08:00 UTC passed:

- 31 mobile settlement SQL assertions: Apple/Google grants, catalog authority, identity conflicts, duplicate delivery, refund/restore ordering, spent-credit debt, rollback on payment conflict, and execution grants.
- 22 bundle cash SQL assertions: capture/refund, duplicate checkout, refund before capture, manual restoration, creator-wallet reversal and execution grants.
- 16 commerce HTTP assertions and 18 payment/webhook HTTP assertions: unauthenticated/forged requests fail with private no-store responses.
- Separate cleanup queries found zero fixture users, profiles, transactions, mobile ledgers/intents, credit adjustments, cash adjustments, orders, purchases, bundles, posts, bundle revisions, wallets or wallet entries.

The SQL probes created only isolated fixtures inside bounded transactions and explicitly rolled back. They did not charge a provider or change real customer balances. Concurrency/load testing remained local and in CI.

Security advisors retain the baseline 1 INFO / 37 WARN / 0 ERROR distribution and the same finding categories. A later, unrelated `manual_nsfw_content` migration changed the wider schema, so the September 29 fingerprint cannot establish an immediate before/after schema diff for this release alone. Both exact function digests and all three ledger entries were checked directly; the full snapshots are preserved as evidence.

Evidence is saved locally under `.audit-evidence/backend-section-05de/`, including CI/release logs, rollback-probe results, independent cleanup results, HTTP logs, schema fingerprints and advisor snapshots. This closes the reproduced mobile grant regression, mobile replay race and cash bundle deadlock release. It does not certify the entire backend or live App Store/Play Store/RevenueCat delivery. Remaining Section 5 work includes provider receipt ownership, commerce event identity conflicts, mobile entitlement refund/restore races and cross-rail reporting.
