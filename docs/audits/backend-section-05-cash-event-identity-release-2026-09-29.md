# Backend Section 5H — cash refund identity release

Status: deployed and verified at 2026-09-29 14:59:17 UTC.

- [PR #243](https://github.com/112kratoss/ugc-copy/pull/243) merged as `8a7672440940730a30d15bc0b3651035d15188d2`.
- [PR Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36584018293) passed all four jobs.
- [Exact-main Quality](https://github.com/112kratoss/ugc-copy/actions/runs/36585132391) passed all four jobs.
- [Production release](https://github.com/112kratoss/ugc-copy/actions/runs/36586241502) passed staging, protected health, promotion and live verification.
- Production ledger version: `20260929145604` (`validate_cash_adjustment_event_identity`).
- Migration: `20260929142945_validate_cash_adjustment_event_identity.sql`.

Local validation: 6,128 web tests, 1,872 pgTAP assertions, 31 focused tests,
seven cash concurrency/Razorpay database cases, test typecheck and targeted lint.
The fresh production ledger planner confirmed one correctly ordered pending
migration. Dependency audit reported zero vulnerabilities.

Baseline reproduction: ten real-Postgres identity assertions and one webhook
adapter case failed before the fix; the production rollback probe independently
showed eight incorrect acknowledgments out of eleven checks. Cleanup found no
remaining fixture rows. No customer data was changed.

Production function digests match the clean local replay:

- `reconcile_marketplace_cash_adjustment(text,text,text,text,text)`: `ec3b14c28e47ffbff656ed71c6c12324`.
- `reconcile_post_resource_cash_adjustment(text,text,text,text,text)`: `c75073b15f088a2b37f833e832ace44f`.

Post-release rollback probe passed 11/11 checks, up from 3/11 before the fix.
Separate cleanup found zero fixtures. Only the functions fingerprint changed;
the other 15 schema classes and all object counts stayed unchanged. Security
advisors remain 1 INFO / 37 WARN / 0 ERROR. Independent live SHA, feed and
unauthenticated webhook checks passed. The authenticated no-op webhook was not
run because its credential was unavailable locally; provider delivery is not certified.

Exact-main Quality passed 6,128 web tests, 2,783 mobile tests, 19 browser tests,
1,872 SQL assertions and 43 database integration/concurrency cases. Private
evidence is under `.audit-evidence/backend-section-05h/` and is not included in the PR.

This verifies cash marketplace/bundle event binding. Shared credit/mobile event
binding, provider delivery, marketplace concurrency and reporting remain open
audit areas; no overall sign-off is implied.
