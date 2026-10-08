# Section 12F — verified referral settlement progress release

PR #412 merged as `f7067d5ef9fda9be8cbc5d5ee26644bd5f00a49b`.
Candidate Quality 37722003054 and exact-main Quality 37722828062 passed all
five jobs; standard production release 37723828380 succeeded. Subsequent
unrelated releases advanced production before independent verification.

At 2026-10-08 13:49:53 UTC, the live build was
`43631e8aa2112cdac259af48cbfa30ce75505179` (standard release 37772138814).
Independent readback confirmed the unchanged reconciliation source and migration,
three SQL function definitions/ACLs, all 21 expected changed schema signatures
against clean replay, and no other schema differences. Migration file
`20261008030002_defer_failed_referral_purchase_settlements.sql` maps to production
ledger version `20261008034053`. Security advisors total 112: the sole addition
is the expected INFO for the private retry table with RLS and no client policies.

Live build/feed returned 200, unsigned admin access redirected to login (307),
and unsigned Kie webhook and referral cron returned 401. The cron response was
private/no-store. At 13:50:22 UTC, a bounded synthetic transaction exercised
service-role deferral, increasing backoff, exclusion until due, due selection,
settlement, atomic retry cleanup and a lost-acknowledgement retry. One purchase
event, two reward entries, correct synthetic balances and no completed retry
were verified before ROLLBACK. Independent cleanup returned zero fixture users,
transactions, programs, ledger entries and retries. No customer balances changed.

Local actual-service coverage includes both immediate and overdue retry cadence
with 100 persistent failures followed by healthy work, then recovery after the
fixture fault is removed. These are two local 101-purchase cases, not production
load tests. Clean replay and 2,340 SQL assertions passed. The broader PAY-04
matrix remains untested. JOB-02 remains failed for the separate 12G unused media
reservation defect until its release is verified.

Private evidence: `.audit-evidence/backend-social/referral-settlement-progress-release/`.
