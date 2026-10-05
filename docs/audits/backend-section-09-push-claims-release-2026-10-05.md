# Section 9E — retry claim release verification

PR #356 passed exact-head Quality 37263340019 on `690aa98f` and merged as
`cd264d3945fd3c77a7b5ffb665f3384973c6ec79` October 5 at 04:36:54 UTC.
The preceding guarded merge checked mobile-store release idle immediately
before the merge. Exact-main Quality 37264292974 and the standard production
release 37264834355 passed.

Independent verification at 09:10 UTC found the live site had advanced to
`177d6c989ec904e124052f5e458d8181bf7ccc0a`. Git ancestry proves it contains
#356, with only mobile and AGENTS changes since that merge. Its exact-main
Quality 37285060694 and standard release 37286445214 passed. The initial exact
#356 live check refused the changed SHA before any database probe; verification
then ran against this inspected, released descendant.

Production function definitions, security/grants, three new columns and the
partial recovery index match the clean replay snapshot. Removing only those
planned additions reconstructs the entire pre-release schema fingerprint.
The migration appears once under the Management API-assigned ledger version
`20261005044506`, name `fence_mobile_push_retry_attempts`; the source version
is `20261005031821`. The release planner supports this unambiguous name mapping.
All six bounded service-role transaction controls pass: durable claim, exclusive
active owner, foreign completion rejection, saved outcome, atomic retirement and
terminal refusal. They were rolled back; fixture users, tokens and deliveries
are absent. All 108 pre-existing security advisor findings remain unchanged.

Independent live checks also pass: exact build ID, public feed 200, admin payout
login redirect 307 and unsigned provider callback rejection 401. Private raw
schema, comparisons, transaction and HTTP evidence is under
`.audit-evidence/backend-social/claims-release/`. No real push, paid provider
call or customer-balance mutation was made.

This closes deployment verification for the retry-claim change. JOB-03 remains
failed while initial-send persistence is repaired and the broader registration,
preference and actual device/provider delivery obligations remain unverified.
