# Section 10F — interrupted deletion cash-refund release

PR [#377](https://github.com/112kratoss/ugc-copy/pull/377) passed exact-head Quality
37505858506 on 34abafbe9cb506ff817111d6fff9402741bfa891. It merged October 6
at 17:57:20 UTC with mobile-store release idle as
ab9eb3ad0ce90e5053e782d9b87231d7a48b57de. Exact-main Quality 37507548395 and
standard production release 37508809231 passed.

Independent verification at 2026-10-06T18:12:33.462Z confirms that exact live
build and the clean-replay trigger definition/ACL digest
`71c46931915488dc968917640b7d4688`. Production ledger version `20261006180733`
uniquely maps to repository migration
`20261006173448_allow_refund_sale_count_during_deletion.sql`.

All 23 bounded rollback controls pass (13/23 baseline), including cash
refund/dispute/restore, pending capture prevention, entitlement and event
bindings during an interrupted deletion. Independent cleanup using returned
fixture IDs finds zero users/profiles/posts/bundles/orders/purchases/revisions/
wallet entries/adjustments/deletion jobs/upload blocks. Only the planned trigger
changes, all 110 security advisor findings remain unchanged, and feed/admin/
unsigned generation webhook return 200/307/401. Private evidence is in
.audit-evidence/backend-social/partial-deletion-refund-release/.

Together with 10E's verified release, the reproduced cash/deletion failures are
fixed and PAY-04 returns to untested for its broader lifecycle matrix. No genuine
payment/refund/provider request, production contention or customer repair was
performed. MEDIA-09's separately reproduced retained-object gate defect is in
10H PR #379 and remains open until its own release verification.
