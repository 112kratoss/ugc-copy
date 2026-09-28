# Section 5D — bundle capture/refund concurrency

Status: local verification complete; release pending.

## Reproduced defect

Bundle cash capture locks the bundle before its order. Cash refund instead locked the order, deleted the purchase and then reached the bundle through refund-ledger foreign keys and creator-accounting triggers. Two pending checkouts for the same buyer can exist before either completes. If the first purchase is being refunded while the second completes, opposing lock acquisition can deadlock: capture holds the bundle and waits for the purchase uniqueness conflict, while refund holds the deleted purchase and waits for the bundle.

The regression uses real, independent local PostgreSQL connections. It pauses capture at the same initial bundle lock that the actual completion RPC takes, starts the real refund RPC, observes a `pg_stat_activity` lock wait, then calls the real capture RPC. Before repair, PostgreSQL returned `40P01` for the refund. This is an availability/retry defect, not evidence of duplicated or lost money; the webhook already returns retryable failure for RPC errors.

## Repair and coverage

`reconcile_post_resource_cash_adjustment` first discovers the order, then locks its bundle, then reloads and locks the order before validation or mutation. It verifies the order still belongs to the locked bundle. The event/payment advisory locks, payment/order conflict checks, refund-before-capture handling, manual restoration policy, entitlement removal and wallet reversal remain unchanged.

Three mandatory local-database integration cases cover:

- Capture holds the bundle first: duplicate checkout terminates; refund completes; no entitlement or available creator proceeds remain.
- Refund holds the bundle first: original sale is reversed; new checkout succeeds; one entitlement, one sale count and exactly 17,000 creator subunits remain for the 200-cent sale.
- Eight simultaneous duplicate deliveries: one adjustment, seven idempotent responses and one wallet refund.

The tests require an explicit localhost `SUPABASE_TEST_DB_URL`, fail on connection errors when enabled, bound statements to eight seconds, and remove fixture users and their dependent commerce records. They run in the mandatory database CI job, alongside credit-unlock concurrency and the real Razorpay handler/SQL suite. No production contention or load test is performed.

## Validation

- Original concurrency case failed before fix with `40P01`, then passed.
- Clean replay of 262 migrations; all 85 pgTAP files / 1,812 assertions passed.
- Three concurrency tests, four existing actual-handler/database tests and the migration boundary guard passed.
- Test typecheck and targeted lint passed.
- `scripts/ops/verify-bundle-cash-refunds.sql`: 22 assertions passed locally using service-role operations inside a rollback transaction. Covers capture, duplicate checkout, refunds, creator wallet reversal, duplicate events, manual restoration, refund-before-capture and API grants.
- PR, exact-main and production verification pending.

## Limits / next audit work

This repair covers one demonstrated bundle-lock cycle. It does not establish that every commerce operation is globally deadlock-free. Existing creator-wallet, payout and credit paths have separate locking contracts. Provider retries remain required for transient database failures.

Event identity conflicts across commerce rails, RevenueCat receipt/transaction ownership, restore/refund ordering, mobile/web double-counting and provider-backed sandbox delivery remain follow-up work. RevenueCat intentionally accepts real Apple/Google sandbox receipts for App Review; this is distinct from client-declared sandbox bypass, which remains disabled on production. No change to that policy is proposed here.

The previous pricing batch is deployed; its complete [production evidence](backend-section-05-commerce-release-2026-09-28.md) is carried in this batch.

A reproduced mobile grant regression was found during the subsequent RevenueCat review and is included in the same release; see [mobile grant evidence](backend-section-05-mobile-credit-grant-2026-09-28.md).
