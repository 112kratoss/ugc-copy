# Section 6E release evidence — 2026-09-30

Status: deployed and independently verified; no release work remains pending.

PR [#251](https://github.com/112kratoss/ugc-copy/pull/251), head
`aa4c26cc3bf49771193ba1f101352f8d1f23db9a`, merged as
`d5d71fba5f367af836e52454a0a549f79ff87dbd` at 13:19:50 UTC.
No mobile store release was active before merge.

PR Quality [36719881177](https://github.com/112kratoss/ugc-copy/actions/runs/36719881177)
passed all four jobs on the first attempt: 6,150 web tests, 2,801 mobile tests,
19 browser tests, 1,941 SQL assertions across 90 files and 95 database
integration/concurrency checks, including 40 generation recovery cases.
The general web suite skips DB-dependent cases; the database job runs them
against a clean migration replay.

Exact-main Quality: [36720852933](https://github.com/112kratoss/ugc-copy/actions/runs/36720852933).
All four jobs passed on the first attempt with the same counts as PR Quality.
Production release [36721626640](https://github.com/112kratoss/ugc-copy/actions/runs/36721626640)
succeeded at 13:29:34 UTC, including protected staged/live health verification.
Independent smoke checks confirm exact live SHA `d5d71fba`, feed HTTP 200, admin
payout redirect to login HTTP 307 and unsigned Kie webhook HTTP 401.

Incomplete HTTP-success task receipts now use the existing ambiguous-start hold.
Actual isolated start/callback HTTP demonstrates pending response, callback
attachment and same-key replay with one provider call and one hold. Explicit
rejections still refund. The shared contract pins the existing 409 response and
mobile error handling. No migration or mobile runtime/binary/OTA change.

The production aggregate has seven unmarked refunded taskless generations;
these also match legitimate provider rejection and are not attributed incidents.
Zero marked ambiguous or active taskless generations were found. No customer
repair or production fixture was performed. Local generation, template and
completion-job fixture counts are zero; the HTTP server was stopped.

Private evidence: `.audit-evidence/backend-section-06e/`. Prior Section 6D release
records are committed in this PR. Next: ambiguity-marker write failure and lost
write response, followed by worker process termination. Genuine provider/edge
delivery remains separate from isolated HTTP evidence.
