# Section 6G release evidence — 2026-10-01

Status: deployed and independently verified; no release work remains pending.

PR [#253](https://github.com/112kratoss/ugc-copy/pull/253), head
`7fc510f9567861429b07d6e0d1bfd1f9e63e4d76`, merged as
`d848cd2d71b9f35b2d174b83f0906b5e8a57db55` at September 30, 20:53:06 UTC
(October 1, 02:23:06 IST). No mobile store release was active before merge.

PR Quality [36774458575](https://github.com/112kratoss/ugc-copy/actions/runs/36774458575)
passed after rerunning only its failed browser job without code changes.
The first job had 18 passes and a composer reorder failure: page navigation
destroyed `locator.evaluateAll`'s execution context. The rerun passed all 19.
Original failure and retry logs are preserved. Web, mobile and database jobs
passed initially: 6,153 web tests, 2,802 mobile tests, 1,941 SQL assertions across
90 files and 119 database checks, including 64 generation recovery cases.

Exact-main Quality [36775733672](https://github.com/112kratoss/ugc-copy/actions/runs/36775733672)
passed all four jobs on its first run, including all 19 browser checks without
retry. Web/mobile/SQL/DB counts match the PR results above.

Standard production release
[36776882155](https://github.com/112kratoss/ugc-copy/actions/runs/36776882155)
succeeded September 30 at 21:06:59 UTC (October 1, 02:36:59 IST), including staged
exact-commit verification, promotion and protected production health. Independent
live checks confirm SHA `d848cd2d`, feed HTTP 200, admin payout redirect to login
HTTP 307 and unsigned Kie webhook HTTP 401. Remote main matches the live commit.

This is a regression-test and audit-record batch, with no production application
code or SQL migration change. Nine actual SIGKILL/fresh-process cases extend
recovery coverage across reservation/dispatch, completion claims, durable import
enqueue, upload, settlement and notification. Total/promotional balances and
notification deduplication are checked against real PostgreSQL. Isolated actual
HTTP restart probes passed for before-dispatch expiry/refund and accepted-task
callback/replay. Test typing and lint pass. No mobile runtime/binary/OTA change.

Temporary staging directories surviving SIGKILL are an explicit residual, not
fixed or certified as safe for indefinite host reuse. The next bounded audit is
staging-file ownership, cleanup and disk budgets; private planning notes are in
`next-staging-cleanup.md`. Genuine provider/edge/storage/push delivery, deployment
container replacement and remaining workflow/template obligations stay open.

Local fixture generation/completion/import rows were independently counted at
zero; HTTP workers are stopped. No provider charge, customer balance repair or
production fixture was performed. The preceding Section 6F release evidence is
committed in this PR. Private evidence: `.audit-evidence/backend-section-06g/`.
