# Section 5F — conflicting mobile marketplace restoration

Status: reproduced and repaired locally; release pending.

## Reproduction

An original mobile marketplace purchase is refunded, the buyer purchases the asset again, and the provider restores the original purchase. `reconcile_mobile_purchase_adjustment` previously marked the original order paid and its ledger/intent active/consumed even though the unique entitlement still belonged to the newer order. It returned `already_active`. Refunding the newer order then removed the only entitlement: the database retained one paid order, zero entitlements, and zero creator proceeds. The original restoration event had already been consumed, so its replay could not repair the inconsistency.

A real PostgreSQL reproduction obtained that state. The regression failed eight assertions before the repair. This is a database lifecycle defect; no mock provider result was used to establish it.

## Repair

When restoration encounters an existing marketplace entitlement, it now requires that entitlement to belong to the exact order being restored. If it belongs to a different order (or no matching entitlement remains), the RPC raises an exception. The entire statement rolls back, preserving the original failed order, revoked ledger/intent, and previous provider event. The existing webhook error handler returns 503 and records a processing failure. Same-order repeated restoration remains idempotent.

The change is an additive migration with an exact-one-block guard. It preserves service-only execution and leaves credit settlement and the bundle branch unchanged. Mobile bundle IAP intent creation is already prohibited by the credit-only policy; the new SQL suite explicitly verifies that restriction.

A conflicting restoration requires resolution before replay can succeed. The fix does not refund a second payment or guarantee eventual provider redelivery. The test proves that once the newer purchase is refunded, retrying the unchanged original restore event recreates one entitlement and one creator share. Operator replay may be needed when a conflict outlasts provider retries.

## Production impact preflight

Read-only inspection on September 29 found three configured products, all credits; no non-credit mobile settlement records; and no mobile marketplace paid orders lacking an entitlement. This is therefore a dormant marketplace SKU path under the observed catalog. No customer rows require guessed financial repair. Test SKU provisioning is confined to rollback fixtures and does not register products with RevenueCat or either store.

## Validation

- Clean migration replay succeeded; 87 SQL files / 1,860 assertions passed, including 26 new lifecycle, policy and privilege assertions.
- 33 real-database credit, mobile, cash and Razorpay integration cases passed.
- 44 focused mobile commerce, webhook and migration tests passed, including the existing retryable webhook-error response behavior.
- Focused lint and test TypeScript passed.
- `scripts/ops/verify-mobile-entitlement-restores.sql` passed all 26 assertions locally using service-role calls, bounded timeouts, temporary assertion helpers, and an explicit rollback.
- PR, exact-main Quality, deployment, function parity and production probes remain pending.

Evidence is saved in `.audit-evidence/backend-section-05f/`. The previous completed batch's production verification is carried in [the Sections 5D/5E release report](backend-section-05-commerce-mobile-release-2026-09-28.md).

## Remaining audit coverage

This does not certify all receipt verification or provider delivery. Remaining work includes canonical store transaction identity, cross-rail event identity conflicts, mobile marketplace concurrency, and receipt-backed live provider delivery. Bundle IAP remains disabled. No store build or OTA is required for this database repair.
