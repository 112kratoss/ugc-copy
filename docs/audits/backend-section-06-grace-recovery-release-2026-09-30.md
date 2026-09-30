# Section 6D release evidence — 2026-09-30

Status: deployed and independently verified; no release work remains pending.

PR [#250](https://github.com/112kratoss/ugc-copy/pull/250), head
`ea8e49b6b5db17549001cfdfc8ed3ac9f37bde3a`, merged as
`8a9eda28810066815efafeb5c0feff93dcd48b5f` at 12:02:57 UTC.
No mobile store release was active before merge.

PR Quality [36711122063](https://github.com/112kratoss/ugc-copy/actions/runs/36711122063)
passed all four jobs on the first attempt: 6,150 web tests, 2,800 mobile tests,
19 browser tests, 1,941 SQL assertions across 90 files, and 81 database
integration/concurrency checks, including 26 generation recovery cases.
The general web job intentionally skips DB-dependent cases; the database job
runs them against its clean migration replay.

Exact-main Quality: [36712301682](https://github.com/112kratoss/ugc-copy/actions/runs/36712301682).
All four jobs passed on the first attempt with the same counts as the PR run.
Production release [36713364805](https://github.com/112kratoss/ugc-copy/actions/runs/36713364805)
succeeded at 12:16:38 UTC, including protected staged/live health checks.
Independent verification confirms exact live SHA `8a9eda28`, public feed HTTP 200,
admin payout redirect to login HTTP 307 and unsigned Kie webhook HTTP 401.

The fix requests callback redelivery on unconfirmed reconciliation writes.
Signed local HTTP before/after evidence demonstrates 200/no record before and
503 followed by 200/one record after; duplicate delivery leaves the same record
and refunded balance. No production fixture, customer repair, provider charge,
migration, mobile binary or OTA is involved.

The production aggregate contains zero marked or refunded ambiguous generations
and zero reconciliation rows. Security advisor identities match Section 5K's
saved snapshot exactly: 108 individual findings (66 INFO, 42 WARN, zero ERROR),
with no added or removed identity. Earlier reports counted grouped entries
(1 INFO / 37 WARN), which is not an individual-finding count. Performance
advisors currently contain 94 INFO findings and no WARN/ERROR; this is a snapshot,
not a comparison. Existing warnings are not cleared by this release. Advisory
reference: [Supabase database advisors](https://supabase.com/docs/guides/database/database-advisors).

Private evidence: `.audit-evidence/backend-section-06d/`; fixture scripts assert
cleanup after each signed HTTP probe and database tests roll back their fixtures.
The next audit batch is start-route idempotency and lost provider creation
response, including failure to persist the ambiguity marker. Worker process
termination and genuine provider edge delivery remain separate obligations.
