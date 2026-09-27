# Section 2 — financial table ownership

Status: scoped production validation passed on 2026-09-27. No application or
schema change was required. This batch adds repeatable regression coverage.

## Scope and results

| Relation | Owner reads | Foreign rows hidden | Direct insert/update/delete blocked | Guest, banned, revoked reads blocked |
| --- | --- | --- | --- | --- |
| transactions | Pass | Pass | Pass | Pass |
| creator_resource_wallets | Pass | Pass | Pass | Pass |
| creator_resource_wallet_entries | Pass | Pass | Pass | Pass |
| creator_payout_requests | Pass | Pass | Pass | Pass |

`supabase/tests/database/financial_table_ownership.test.sql` adds **48** pgTAP
assertions with populated fixtures for two registered identities and one guest.
It checks every relation, direct column grants, actual denied mutations,
auth-row guest status even with a false guest JWT claim, bans, session revocation,
anonymous denial and retained service-role reads. Every test transaction rolls
back. The full isolated database suite passed **78 files / 1,569 assertions**.
There are no new migrations; the 254-migration replay from the preceding batch
is unchanged on this branch.

## Production evidence

`scripts/ops/verify-financial-table-ownership.sql` passed the same **48 assertions**
on production using transaction-local JWT claims and SET ROLE. This validates
database policies with populated records; it does not simulate signature
verification over HTTP. Helpers are temporary, SECURITY INVOKER, and granted
only inside the rolled-back transaction. Fixture inserts and applicable triggers
were reviewed: no provider call, transfer or external side effect is invoked.
No financial row or helper DDL was committed. A separate query confirmed zero
remaining fixture users, transactions, wallets, entries and payout requests.

At **13:33:39 UTC**, `scripts/ops/verify-financial-table-boundaries.mjs` passed
**74 live HTTP checks** on production build
`5837720a72e05531fb59acd0a27de6c7e0f951b9`:

- Two real registered sessions and one guest exercised all four Data API tables.
- Direct INSERT, protected-value UPDATE and DELETE returned SQLSTATE 42501.
- Unauthenticated reads returned permission errors.
- Registered payout GET returned private, uncached, zero-balance state and no history.
- Guest payout GET returned 403; signed-out, banned and revoked sessions returned 401.
- The service-role absence check confirmed no financial rows were created.

The HTTP fixtures intentionally have empty financial histories. Their empty
reads establish transport compatibility, not populated-row isolation; that
positive/negative ownership evidence comes from the rolled-back SQL matrix.
The verifier never calls payout POST, purchase, refund or provider endpoints.
All three disposable identities were removed. An independent query confirmed
zero tagged auth identities and zero rows across all four financial tables for
the final fixture IDs. Earlier attempts stopped because the test expected the
wrong guest/banned status code; each removed its identities before retrying.
Production behavior matched the existing admission implementation; only the
verifier expectations were corrected.

Node syntax, focused ESLint and whitespace checks passed. CI and PR disposition
are recorded in the pull request. No production fix is claimed by this batch.

## Remaining scope

This closes direct table ownership for these four relations. It does **not**
certify payment signatures, webhook replay/idempotency, credit settlement,
refunds, payout state transitions, retention after account deletion, ledger
accounting, privileged RPCs, or concurrency. Those require separate batches
with their own fixtures and invariants. The full backend audit remains open.
