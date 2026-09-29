# Section 5F — mobile marketplace restore production verification

The conflicting-restore repair is deployed in `3fa79f92fe906b934b0e5d7dfcceeaddfede7259`. The live `/api/app-version` endpoint returned that exact build during final verification on September 29 at approximately 10:02 UTC.

## Release evidence

- Fix PR [#240](https://github.com/112kratoss/ugc-copy/pull/240) merged as `afe26d97`. Its PR Quality passed; initial main Quality had a browser navigation/context-destroyed failure in the composer drag test. The unchanged failed-job rerun passed. This did not exercise payment code.
- Initial production run [36544614587](https://github.com/112kratoss/ugc-copy/actions/runs/36544614587) rejected the pending migration ordering before applying SQL. Production inspection confirmed the old function and absent migration entry.
- Correction PR [#241](https://github.com/112kratoss/ugc-copy/pull/241) renamed only the unapplied migration to `20260929120001_reject_conflicting_mobile_entitlement_restores.sql`. Its SQL body was unchanged. The actual release planner against the complete production ledger reported exactly one pending migration and no ordering violation.
- Correction PR Quality [36544987173](https://github.com/112kratoss/ugc-copy/actions/runs/36544987173) and final exact-main Quality [36546155229](https://github.com/112kratoss/ugc-copy/actions/runs/36546155229) passed all four jobs: 6,122 web tests, 2,783 mobile tests, 19 browser tests, 1,860 SQL assertions, 2 credit concurrency tests, 27 cash/mobile concurrency tests and 4 real Razorpay handler/database tests. The 31 cases skipped in the ordinary web job ran in the database job.
- Production release [36547282981](https://github.com/112kratoss/ugc-copy/actions/runs/36547282981) passed migration, stage, health checks, promotion and live verification, completing at 2026-09-29 09:12:42 UTC.

The production ledger records the migration under Management API version `20260929090935`. The deployed `reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)` definition has MD5 `4de80dd5b34a0e99fa3b3d756a0f8c10`, exactly matching the clean local replay.

## Production validation

The fixture-only probe passed all 26 assertions after migration: original purchase/refund, repurchase, conflicting restoration rollback, preservation of the prior event and revoked state, newer purchase refund, successful retry of the original restore event, duplicate restoration, creator-wallet amounts, blocked bundle IAP and service-only execution. The probe used bounded timeouts and an explicit rollback, with no provider calls.

Independent cleanup queries found zero fixture users, profiles, store products, mobile intents/ledgers, marketplace assets/orders/purchases, posts, bundles/revisions, wallets and wallet entries. Customer balances and real product registrations were not changed.

After live promotion, 16 commerce and 18 payment/webhook HTTP assertions passed, checking unauthorized/forged-request rejection and private no-store headers. These do not constitute successful provider receipt delivery or new store charges.

Only the `functions` schema fingerprint class changed; the other 15 classes were unchanged. Security advisors retained the baseline 1 INFO / 37 WARN / 0 ERROR distribution and the same categories. Evidence, including failed and successful CI/release logs, probe output, cleanup, fingerprints and advisor results, is saved locally under `.audit-evidence/backend-section-05f/`.

## Scope and remaining work

Production preflight found only three credit SKUs, no non-credit mobile settlement records and no affected mobile marketplace paid orders. The repaired marketplace path was dormant under that catalog; no customer-data backfill was needed. Conflicting restores now fail atomically through the existing retryable webhook path. A conflicting payment must still be resolved before replay can succeed; this repair does not issue provider refunds or guarantee eventual redelivery.

The next receipt-identity investigation is documented in `.audit-evidence/backend-section-05f/receipt-identity-next.md`: whether a RevenueCat-only ID later accompanied by a store transaction ID can produce two settlement keys. It is an unverified gap, not a confirmed production finding. The full backend audit remains open.
