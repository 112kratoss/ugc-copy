# Backend Section 5G — receipt identity release

Status: deployed and verified on 2026-09-29 at 14:24 UTC.

- [PR #242](https://github.com/112kratoss/ugc-copy/pull/242) merged as `8db0efbde28ce23414ed8e6e51001a4d1e9ef6d2`.
- [PR Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36557881708) passed all four jobs: 6,122 web tests, 2,783 mobile tests, 19 browser tests, 1,860 SQL assertions and 43 database integration/concurrency cases, including ten receipt identity cases.
- [Exact-main Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36580975495) passed all four jobs, with the same test counts as the PR run.

Four prevention cases failed on the baseline and passed after restricting receipt
settlement to `store_transaction_id`. Local database tests cover both Apple and
Google: incomplete sync and restore grant nothing; later complete receipts grant
once; replay does not grant again; store refunds reverse the same settlement.

The patched verifier also fetched and accepted all eight existing RevenueCat
receipts read-only, preserving their store IDs and genuine sandbox classification.
Fresh compatibility checks before merge and while exact-main Quality ran found
eight store-ID settlements and zero RevenueCat-only keys. No migration, customer
balance repair, store purchase, or provider refund was performed.

The provider's missing-ID-to-store-ID transition remains unobserved. The fix
prevents its locally reproduced consequence; it does not certify live provider
delivery or complete the wider backend audit.

Local evidence remains under `.audit-evidence/backend-section-05g/`; private
ledger input must not be committed. Pre-existing Section 1 evidence is preserved.

## Production verification

[Production release 36581966542](https://github.com/112kratoss/ugc-copy/actions/runs/36581966542)
completed successfully at 14:24:20 UTC. The migration ledger was already current;
staged public/authenticated health, feed smoke, promotion, live commit and
protected production health checks passed.

Independent post-release HTTP checks confirmed build
`8db0efbde28ce23414ed8e6e51001a4d1e9ef6d2`, a valid public feed (200), and rejection
of an unauthenticated RevenueCat webhook (401). The optional authenticated TEST
webhook was not run because its credential was unavailable locally; do not count
this as provider-delivery verification.

All 16 schema fingerprint classes match the pre-release snapshot. Security
advisors retain 1 INFO / 37 WARN / 0 ERROR. The eight mobile credit transactions
still have matching ledger source, owner and product bindings, and the live REST
receipt comparison still matches all eight store IDs with zero REST-only IDs.
No production fixtures or customer-balance mutations were used for this release.
The earlier local rollback tests left zero receipt fixture rows; Docker was later
stopped, so the final repeat of that local cleanup query was unavailable. The
exact-main CI database tests independently passed afterward.

No release is pending. This release report and the updated handoff remain local
for the next appropriate audit PR; all implementation and test changes are in #242.
