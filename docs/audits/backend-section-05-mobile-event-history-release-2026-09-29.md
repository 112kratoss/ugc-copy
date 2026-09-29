# Backend Section 5J — mobile event history release

Status: deployed and verified. Updated 2026-09-30 Asia/Kolkata (2026-09-29 UTC).

[PR #245](https://github.com/112kratoss/ugc-copy/pull/245) preserves mobile
adjustment event identity across receipts, actions, timestamps and subsequent
restores. Conflicting reuse returns `event_conflict` through the existing
retryable HTTP adapter. New mobile bundle IAPs remain blocked.

## Build and release

- PR merged as `0c473693a270890c334ce6745e706e25a3e35ad3` at 18:45:21 UTC.
- Deployed main: `041ff8a5cf3280c7438285e6eb4fd33cc615490f`.
- [PR Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36599421812)
  and [exact-main Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36615600319)
  passed all four jobs.
- Exact-main results: 6,136 web tests; 2,783 mobile tests; 19 browser tests;
  1,922 SQL assertions; 50 database integration/concurrency cases.
- [Standard production release](https://github.com/112kratoss/ugc-copy/actions/runs/36616927718)
  succeeded at 2026-09-29 19:10:56 UTC, including migration, staging,
  verification and promotion.
- Repository migration `20260929163206_retain_mobile_adjustment_event_identity.sql`
  maps to production ledger version `20260929190728`.

GitHub delayed the push-triggered Quality runs. One empty retry commit produced
current main; its tree is identical to the PR merge. Both delayed runs eventually
appeared, and only current-main Quality authorized this release. No workflow
settings or gates changed. No mobile store release was active before either
main update. The trigger delay's cause remains unconfirmed.

## Verification

- Baseline: 15 of 28 real-Postgres identity assertions failed. The completed
  identity suite has 36 passing assertions, plus a failed-restore reservation
  regression in the entitlement suite. Three true concurrency cases verify
  receipt, retained-event, entitlement and creator-wallet consistency.
- Local clean replay and all 1,922 SQL assertions passed. A local backfill probe
  preserved a pre-migration refund and rejected its conflicting reuse.
- Production rollback probe: **14/14 passed**, versus 7/14 before migration.
  Separate cleanup found zero fixture users, receipts, products, credit
  adjustments and event-history rows. No real customer balances or provider
  charges were changed; production probes used no bundle-policy bypass.
- Production function digest matches local replay for
  `reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)`:
  `c5451d4cf12210233f8235f4042ce921`.
- Schema changes are confined to the expected seven fingerprint classes:
  column order, columns, constraints, functions, table grants, indexes and
  tables. They reflect one table, five columns, five constraints, two indexes,
  service-role SELECT access and the modified existing function. Nine other
  classes are unchanged.
- Security advisors remain **1 INFO / 37 WARN / 0 ERROR** grouped lints.
  Comparing individual findings without observation timestamps adds only the
  expected INFO for `mobile_purchase_adjustment_events`: RLS enabled with no
  client policy. That INFO group's findings increased from 65 to 66; warnings
  are unchanged and no findings were removed.
- Independent live checks: build endpoint 200 with exact SHA `041ff8a5`, public
  feed 200, unauthorized RevenueCat webhook 401. An authenticated TEST webhook
  was not run because its credential was unavailable locally.
- Pre-release production inventory had eight credit receipts and no noncredit
  receipts or processed-event snapshots; no historical customer repair was needed.

Evidence is in `.audit-evidence/backend-section-05j/`, including before/after
rollback probes, cleanup, digests, fingerprints, advisors, CI/release logs and
`release-smoke.json`. Preserve private evidence without blindly committing it.

This verifies synthetic RPC behavior and the live build/authentication boundary.
It does not certify real provider delivery, the overall marketplace lifecycle,
or completion of the backend audit. Continue with marketplace lifecycle and
concurrency beyond event identity, legacy bundle restore ownership and reporting.
