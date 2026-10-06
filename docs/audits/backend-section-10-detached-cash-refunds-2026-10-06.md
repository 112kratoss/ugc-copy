# Section 10E — cash reconciliation after creator deletion

Actual local capture followed by Storage/Auth deletion and a service-role refund
returned `not_found`. The buyer could still mint and read the retained paid file.
The live-creator control passed. The refund function required a live bundle even
though orders, purchased revisions and entitlements intentionally survive creator
deletion with `bundle_id = NULL`.

A second actual PostgreSQL race reproduced SQLSTATE `40P01`: refund held the
bundle while Auth deletion held rows in its wallet cascade. The refund's later
wallet reversal completed the conflicting lock cycle. Before-fix logs are kept
privately, including the one-pass/one-fail file-access reproduction and the
independently reproduced deletion race.

The new migration keeps event/payment/order identity checks and idempotency.
For a live creator it acquires Auth KEY SHARE before bundle and order locks,
matching Auth erasure's parent-first order. It reconciles the surviving order
when the bundle is already detached or disappears while waiting. A surviving
nonnull bundle binding must still match; a different bundle is rejected. Refund
and dispute revoke the entitlement and fail the order. Restore remains manual
review and does not automatically regrant access. Existing wallet reversal
logic remains unchanged.

Verification:

- 35 actual local Auth/Storage/PostgREST/SQL deletion/access cases pass on Node
  24.21.0 (160.06 seconds), including 33 prior controls and the two new cash
  cases. The cash fixtures were then strengthened to use the actual authoritative
  quote and order-recording RPCs before capture; those two cases pass again.
- Five actual PostgreSQL concurrency cases pass, covering existing capture and
  refund orderings/duplicate delivery plus deletion winning and refund winning.
  No production contention test was performed.
- A clean migration replay passes all 2,125 pgTAP assertions in 99 files. The
  new file adds 23 service-boundary, detached refund/dispute/restore, pending
  capture, entitlement, replay and event-identity assertions.
- Three migration guards, test types and scoped lint pass. Local tracked
  Storage/Auth/job/entitlement fixture cleanup passes.
- A bounded production rollback probe reproduces 16 failed controls of 23
  before deployment; all 23 pass against clean local replay. Independent
  production cleanup confirms zero fixture users/profiles/posts/bundles/orders/
  purchases/revisions/wallet entries/adjustments. Read-only inventory finds
  three detached paid orders and no detached created orders. That inventory
  does not establish that a real refund was lost; no customer rows were repaired.
- The complete production migration ledger plans exactly one ordered new
  migration: `20261006172011_reconcile_detached_bundle_cash_refunds.sql`.
  Production release and independent after-deployment verification remain.

The actual payment provider was not contacted. Quote/order/capture/refund are
real local SQL/PostgREST calls using inert provider identifiers. File access is
real local Storage. Revocation denies new application-issued signed URLs;
already-issued capabilities can remain usable until their TTL/cache lifecycle.
This does not prove immediate revocation of cached URLs or genuine provider
refund delivery. PAY-04 is failed until this defect is released and verified;
its broader lifecycle matrix, MARKET-03, AUTH-03 and MEDIA obligations stay open.
