# Section 5E — restore mobile credit settlement after shared-grant hardening

Status: reproduced and repaired locally; release pending in PR #237.

## Regression and evidence

Section 5A made `add_credits` reject transactions with `mobile_product_id`, treating it as the Razorpay-only grant boundary. That was incomplete: `complete_mobile_purchase` still called that function after verifying catalog/intent authority and inserting a unique mobile ledger row. Thus new mobile credit settlement raised `mobile credit settlement failed`. The same call exists in production. A real PostgreSQL regression test reproduced the exception before this patch. Prior migration/string tests and service mocks did not execute the complete mobile grant path against the database; this was a coverage gap in the earlier fix.

The new migration replaces only that call block with an atomic mobile grant inside `complete_mobile_purchase`. Existing server product/intent checks, store transaction ownership, unique ledger insertion, transaction row lock and service-only execution remain in force. The mobile branch validates the unapplied effect and payment binding, updates the profile, then marks the transaction successful with its credit effect applied. Any error rolls back the profile, transaction, auto-intent and mobile ledger together. The Razorpay `add_credits` protections remain unchanged.

A guarded function-body patch requires exactly one known old block and fails migration if it differs. It preserves unrelated historical function changes instead of rewriting the full settlement function. Both mobile sync and webhook settlement use this backend RPC; no mobile app binary or OTA change is needed.

## Validation

- The original SQL case failed with `mobile credit settlement failed` before repair.
- 31 real-database assertions cover Apple/Google success, catalog credit amounts, duplicate sync, user/SKU/provider conflicts, unknown products, orphan-intent prevention, spent-credit debt, refund replay, stale restore/refund, legitimate restoration, payment uniqueness rollback and service-only grants.
- Two independent-connection tests issue eight concurrent requests: one owner with duplicate delivery, and two competing owners for one store transaction. Each yields exactly one 500-credit grant, one mobile ledger and one auto-intent.
- The new SQL and concurrency cases are mandatory in the database CI job.
- The 31-assertion production probe passed locally as service_role inside a rollback transaction. Live verification pending.

## Impact check and limitations

Read-only production telemetry from 2026-09-27 19:04 UTC through the audit found no recorded RevenueCat/payment-webhook events in `provider_dependency_events`. This does not prove there were no affected attempts: client sync failures may be absent from that telemetry. No customer credit repair was guessed or applied. A provider-verified sync/restore or retry after release can settle a previously failed purchase because its failed transaction rolled back atomically.

This validates database settlement, not new live store charges or provider event delivery. Real RevenueCat sandbox receipts used for App Review intentionally remain accepted; client-declared sandbox bypass stays disabled in production. The broader RevenueCat receipt/lifecycle audit remains open, including live provider delivery, event identity conflicts and cross-rail reporting.
