# Section 8F — post and recipe restore release

PR #345 passed all four Quality jobs in 37228631674 and merged as
`94d1bf0c3b3304790125d43bafca78216557534c` on October 4 at 20:03:03 UTC.
No mobile store release was active immediately before merge. Exact-main Quality
37230606348 passed; standard production release 37231227200 succeeded at
20:17:02 UTC. Independent exact live SHA, feed 200, admin auth redirect 307
and unsigned webhook 401 checks pass.

Migration `20261004161150_allow_service_recipe_exposure_quality_check.sql`
maps to production ledger `20261004201316`. Both function definitions match
clean replay: quality helper `351e8cbab9f2dd5cc7d21ea2744a76a7`, exposure trigger
`2676b3f0f158f4be6c9a81a6a908fe9b`. Only service_role gains EXECUTE on the
quality helper; anon/authenticated remain denied. The trigger remains invoker-rights.

Five bounded, isolated production rollback controls now pass (three passed and
two failed before release): client denials, service execute, archive demotion and
restore publication. An independent cleanup query finds zero fixture users,
posts and bundles. Local real-PostgREST tests also verify delayed archive responses
cannot demote restored free or paid recipes. No customer repair was performed.

Only the routine-grants schema fingerprint changed: 282 to 283 effective grants.
Excluding precisely the planned helper/service grant from the canonical fingerprint
query reconstructs every pre-release schema digest exactly. The first verifier
rejected a separately constructed expected digest; that calculation sorted with the default collation while the canonical query
uses C collation, confirmed by database inspection. Its failed output is retained; the canonical-query comparison
proves the exact delta without accepting a changed digest blindly. All 108 individual
security advisor findings are unchanged (not comparable to earlier grouped counts).

Private evidence: `.audit-evidence/backend-social/restore-release/`, including
before/after inspection, rollback checks, independent cleanup, schema comparison,
advisors and live smoke. Existing CLI login supplied Management API access without
exposing credentials. SOCIAL-01 returns to untested for the broader visibility matrix.
