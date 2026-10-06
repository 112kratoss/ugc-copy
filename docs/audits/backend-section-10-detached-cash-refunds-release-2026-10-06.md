# Section 10E — detached cash reconciliation release

PR [#376](https://github.com/112kratoss/ugc-copy/pull/376) passed exact-head Quality
37504089324 on f75a0c1642f5ac82fb613dde41dd72f75897a71b. It merged October 6
at 17:39:55 UTC with mobile-store release idle as
b82a7de987ad08212edc12b134be02e2a3d8be6c. Exact-main Quality 37505298701 and
standard production release 37506928664 passed.

Independent verification at 2026-10-06T17:56:54.708Z confirms that exact live
build and the clean-replay function/ACL digest
`2221e0c036bde0d9f68ad80c1f54b3d6`. Production ledger version `20261006175317`
uniquely maps to repository migration
`20261006172011_reconcile_detached_bundle_cash_refunds.sql`.

All 23 bounded production rollback controls pass (7/23 baseline), including
detached refund/dispute/restore, pending capture, entitlement, replay and event
binding checks. Independent cleanup using each run's returned fixture IDs finds
zero users/profiles/posts/bundles/orders/purchases/revisions/wallet entries/
adjustments/deletion jobs/upload blocks. Only the planned function changes;
all 110 security advisor findings remain unchanged. Feed returns 200, admin
payouts redirects to login (307), and an unsigned generation webhook returns 401.
Private evidence is in .audit-evidence/backend-social/detached-refund-release/.

The release includes 10D's six retained-access/signature/expiry evidence cases
and fixes detached cash rejection/refund-erasure deadlock. No genuine payment,
refund, provider call, production contention or customer repair was performed.
The separately reproduced interrupted-deletion freeze failure is in 10F #377;
PAY-04 stays failed until that defect is independently verified too, with the
broader matrix remaining open afterward.
