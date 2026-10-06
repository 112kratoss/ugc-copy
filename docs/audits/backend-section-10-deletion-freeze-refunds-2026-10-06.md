# Section 10F — refunds during interrupted creator deletion

A real local Storage deletion failure and a real Auth deletion failure both
leave the creator's durable deletion job failed and its live bundle frozen.
After authoritative quote/order/capture, a cash refund in either state returned
PostgreSQL `55000` (`Account deletion is already in progress`). The transaction
rolled back its entitlement/order/wallet changes. Direct SQL also reproduces
this for refund and dispute; restore already returns manual review correctly.
This is separate from 10E's detached-order rejection and erasure deadlock.

The trigger candidate exempts one strictly decreasing sales-counter update
when every other field except `updated_at` is unchanged. It requires a positive
old count and an exact decrement of one; zero/no-op writes retain the freeze.
Content, owner, pricing, publication, resource paths and wallet amounts cannot
change through this exception. Counter increments and new captures stay blocked.
The existing nested-trigger/cascade and moderation exceptions and trigger-only
execution ACL remain unchanged.

An initial broader zero-floor allowance failed the existing frozen-bundle
no-op regression on clean replay. It was tightened to the strict decrement
above; the original regression remains unchanged and passes. No applied
production migration was edited. The new migration is
`20261006173448_allow_refund_sale_count_during_deletion.sql`.

Validation:

- Both actual PostgREST regressions fail before and pass after the candidate.
  Refund revokes the entitlement, brings sales count to zero, denies fresh file
  URL minting, and the failed deletion job then retries through Auth cleanup.
- All 37 actual local Auth/Storage/PostgREST/SQL deletion/access cases pass on
  Node 24.21.0 (160.92 seconds), with tracked fixture cleanup verified.
- Clean replay passes 2,163 pgTAP assertions in 100 files. The new 38 assertions
  cover cash lifecycle/replay/identity/ACL, wallet and counter reversal, unchanged
  job state, and rejection of content, publication, price, storage-path and
  counter-increment writes and new captures during deletion.
- Migration guard, test types and scoped lint pass.
- A bounded production rollback baseline reproduces 10 failing controls of 23.
  Separate cleanup confirms zero fixture users/profiles/posts/bundles/orders/
  purchases/revisions/wallet entries/adjustments/deletion jobs/upload blocks.
  The same 23 controls pass on clean replay. No customer rows were repaired.

Production release and independent function/schema/advisor/live verification
remain. 10E is merged in PR #376; its release does not close this retry-state
failure. PAY-04 remains failed until both defects are released and independently
verified, and its broader event matrix remains open afterward. These are real
local and rolled-back SQL operations using inert payment identifiers, with no
actual purchase/refund provider request. Existing signed URLs retain their own
TTL/cache lifecycle; denial here is of new application-issued URLs.
