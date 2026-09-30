# Section 6F release evidence — 2026-10-01

Status: deployed and independently verified; no release work remains pending.

PR [#252](https://github.com/112kratoss/ugc-copy/pull/252), head
`794a961bcfe782896bc95a7a6f69a95beac835a2`, merged as
`1eb94f13a303d28f4071f1772efd7caf90378673` on September 30 at 14:36:22 UTC.
No mobile store release was active before merge.

PR Quality [36729025150](https://github.com/112kratoss/ugc-copy/actions/runs/36729025150)
passed all four jobs on the first attempt: 6,153 web tests, 2,802 mobile tests,
19 browser tests, 1,941 SQL assertions across 90 files and 110 database checks,
including 55 generation recovery cases. The general web suite skips DB cases;
the clean-replay database job runs them separately.

Exact-main Quality [36730702272](https://github.com/112kratoss/ugc-copy/actions/runs/36730702272)
passed all four jobs on its first run with the same web/mobile/SQL/DB counts.
Browser results were 18 passed and one flaky test that passed its automatic
retry: `public-search.spec.ts:35`, waiting for the search empty-state text.
The PR's 19 browser tests passed without this retry. Preserve the flaky result;
it is not evidence that every main browser test passed on its first attempt.

Standard production release
[36731984597](https://github.com/112kratoss/ugc-copy/actions/runs/36731984597)
succeeded September 30 at 14:58:19 UTC, including exact-commit staging,
promotion and protected production health. Independent checks resumed October 1
confirm live SHA `1eb94f13`, feed HTTP 200, admin payout redirect to login HTTP
307 and unsigned Kie webhook HTTP 401. Main still matches the released commit.

Ambiguous generation starts now survive marker-write failures without premature
refund or loss of the request key. The reaper restores missing evidence before
expiry refunds so later callbacks remain reconcilable. The shared 409 response
uses cautious wording if marker state cannot be confirmed. No migration, mobile
runtime change, binary or OTA is required. Section 6E release evidence is committed
in this PR.

Local evidence includes 15 reproduced real-database failures, 183 passing focused
web/database checks, 120 mobile contract checks, typing/lint and actual isolated
HTTP start/callback/replay for both transient and persistent marker outages.
Production checks were read-only; no customer balance repair or production
fixture was performed. Local generation/template/completion fixtures were cleaned
up and the HTTP server stopped. Genuine Kie/edge delivery remains unverified.

Private evidence: `.audit-evidence/backend-section-06f/`. Next: actual process
termination during dispatch/attachment and durable completion/import leases;
see `next-worker-termination.md` in that evidence directory. The broader audit
remains open, with no measured completion percentage.
