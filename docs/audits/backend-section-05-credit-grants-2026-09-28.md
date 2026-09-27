# Section 5A — credit purchase settlement evidence

Status: reproduced database defect fixed locally; production release pending.
This batch covers Razorpay credit grants and their immediate refund/replay
boundary. It does not close all of payment settlement, disputes, referrals,
marketplace purchases or RevenueCat reconciliation.

## Finding and change

`add_credits` was service-only but did not fully validate payment evidence.
Six real SQL cases granted credits when they should have been rejected:
null requested credits, null payment ID, empty payment ID, whitespace payment
ID, a mobile purchase submitted through the Razorpay grant, and a payment ID
conflicting with the transaction's existing binding. The last case overwrote
the original provider link, which then prevented the original payment's refund
from reconciling. Web verify/webhook callers already validate ordinary inputs;
this is a database invariant gap, not evidence of a public credit-minting exploit.

The production function matched the vulnerable repository definition. A
transaction that was rolled back reproduced both missing evidence and overwritten
binding: a fixture balance rose from 100 to 1,100 across two grants; both
transactions became successful, one without a payment ID. Independent queries
confirmed zero fixture users/transactions afterwards. An aggregate production
check found zero successful web transactions with missing/blank payment IDs and
zero created web transactions already bound to a payment. This is not a full
historical fraud investigation.

Migration `20260927184203_require_credit_grant_payment_evidence.sql` requires a
positive non-null credit count and nonblank payment ID, rejects mobile rows,
preserves an existing payment binding, and trims IDs before storing them. It
retains transaction row locking, the unique payment index, exact stored credit
matching, atomic balance updates and service-only permissions. No data backfill,
price change, provider API call or payment transfer is included.

## Evidence

- `supabase/tests/database/payment_grant_evidence.test.sql`: 37 assertions.
  Before the fix, 32 failed, including cascading state/balance failures from
  the six invalid grants. After the fix, all 37 passed.
- Clean replay: 257 migrations; full pgTAP suite: 81 files, 1,683 assertions.
- Focused application tests: 22 files, 135 tests, covering signatures,
  amount/currency/owner verification, checkout intents, webhook retry behavior,
  refund reconciliation and existing RevenueCat parsing/admission logic.
- Local concurrency: 20 competing calls against one purchase produced one grant
  and 19 refusals; 20 separate transactions sharing one payment produced one
  grant and 19 unique-index errors with rolled-back balances. A 21-call
  capture/refund race ended refunded with the exact pre-race balance. Local
  append-only adjustment fixtures were removed by resetting only the dedicated
  audit database after testing.
- `scripts/ops/verify-credit-grant-evidence.sql` runs the same 37 assertions in a
  production-safe transaction, using temporary invoker helpers, short lock and
  statement timeouts, and a final rollback. No production pgTAP installation.
- `scripts/ops/verify-payment-webhook-admission.mjs` checks nine live HTTP cases
  and their no-store headers (18 checks): missing/forged webhook credentials,
  authentication before payload parsing, oversized Razorpay payload, signed-out
  checkout, and missing verification evidence. These are rejection probes;
  successful checkout and provider delivery are not claimed.
- Security advisor baseline: 1 INFO, 37 WARN, 0 ERROR. Existing notices are
  unchanged context, not a clean security certificate.

## Remaining Section 5 batches

1. Refund/dispute ordering and cumulative accounting, including concurrent
   adjustments, partial refunds, restores, spent-credit debt and referral effects.
2. Marketplace and resource-bundle money/entitlement/creator-ledger settlement.
3. RevenueCat receipt authority, transaction ownership, restore/refund ordering
   and mobile/web double-count prevention.
4. Provider-backed sandbox end-to-end purchases/refunds and delivery/retry
   configuration. Passing local tests or a signed synthetic callback alone does
   not establish that a provider actually delivers its events.

Section 4's production verification is recorded in
[the payout release report](backend-section-04-payouts-release-2026-09-27.md).
