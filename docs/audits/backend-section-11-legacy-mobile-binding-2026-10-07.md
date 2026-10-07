# Section 11L — legacy mobile product binding

The remaining documented mobile catalog operator,
`bind_legacy_mobile_store_transaction_product(text,text)`, is service-only and
changes a historical receipt's `legacy.*` product to its verified catalog SKU.
This batch adds behavior evidence; no runtime, migration, customer receipt,
catalog configuration or provider operation changes. No new defect is established.

All 40 actual PostgreSQL assertions pass:

- Anonymous/authenticated calls and direct service-role table writes are denied.
  Invalid orders/products and type, amount, currency or credit mismatches reject
  without changing the original receipt or intent.
- Matching marketplace, historical post-resource and credit products bind both
  records once. Same-product retries return `already_bound`; another valid SKU
  returns `identity_conflict` and preserves the first product.
- A retired SKU can identify a historical receipt without reactivation. Binding
  preserves a detached account and revoked status, every other identity/state
  field, zero fixture balances, and the absence of credit purchases.
- A pre-bound inconsistent intent rejects its update and leaves the receipt
  unbound; both records retain their original products.

The historical post-resource fixture is constructed with only the INSERT-only
credit-only guard temporarily disabled inside the rollback transaction. That
guard is restored before all operator assertions; identity triggers remain
enabled throughout. This does not authorize new post-resource store purchases.

Three additional real database concurrency cases use separate connections and
actual service-role calls. `pg_stat_activity` confirms the second request waits
on a lock held by the first binding transaction. After the first commits, a
duplicate returns `already_bound` and a competing SKU returns `identity_conflict`.
After the first rolls back, the waiting competing SKU binds successfully. The
final intent/receipt products agree; every other persisted field and zero balances
are preserved. Exact fixture cleanup runs after each case and independently
reads back zero Auth/profile/intent/receipt/product rows.

The full owned replay suite passes 2,304 assertions in 106 files. Test types,
scoped lint and diff checks pass after correcting an initial SQL literal typo
and the concurrency promise annotation; those failed development checks are
preserved privately. No production behavior fix was needed. The concurrency
suite is included in Quality's real database job, while the SQL controls run
with all pgTAP files.

Separate read-only production/local comparison agrees for the operator and
three relevant trigger definitions, execution metadata and grants. The binding
digest is `db8efb5b0dad7402f63f00869deb7c8a`, with
`{postgres=X/postgres,service_role=X/postgres}` execution privileges. This does
not claim a new production binding, verified historical provider order, genuine
store purchase/refund, or installed-client restore.

Permanent controls are `supabase/tests/database/mobile_legacy_binding_operator.test.sql`
and `src/__tests__/mobile-legacy-binding-concurrency.test.ts`; private results,
read-only parity and cleanup evidence are under
`.audit-evidence/backend-social/legacy-binding*` and `mobile-legacy-binding*`.
This extends DB-03/MAP-02/PAY-04 evidence without closing their broader matrices
or provider-dependent PAY-05. The 53-row checklist is unchanged. Hold the next
main merge for independently verified #389, exact candidate CI and the standard
release gates.
