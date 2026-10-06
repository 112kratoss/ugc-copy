# Section 11I — health sampling across the Data API ceiling

The shared backend health collector requests 1,001 rows to detect whether its
1,000-row sample is incomplete. The actual Data API caps each response at 1,000,
so that extra-row test never sees truncation. Three real PostgREST regressions
reproduce this for recent generations, AI usage and provider dependency events:
SQL/exact API counts show 1,001 rows, the report shows 1,000, and no
`HEALTH_SAMPLE_TRUNCATED` issue is emitted. Three 1,000-row controls pass.

These three reads now request exact window counts alongside the bounded rows.
The collector emits its existing sampling warning when either its own budget
or the Data API ceiling cuts the window. All reported counts/rates still describe
the bounded sample; this is not a full-window aggregation change. Sample budgets,
query count, job execution, thresholds and response shape remain unchanged.
Exact counts add database count work within the existing sixty-minute filters.

A fourth transport regression strips Content-Range and reproduces an accepted
report without the metadata needed to establish completeness. Missing, nonfinite
or inconsistent count metadata now rejects the report. Other read errors already
propagate. The smaller completion-queue sample retains its existing extra-row
control; its request is below the actual Data API ceiling.

All 48 actual Auth/PostgREST/SQL collector cases pass, including the six
1,000/1,001 window controls and missing-count transport case. All 48 focused
health/dashboard/overview cases, app/test types, scoped lint and diff checks pass.
The unit SDK stand-in now supplies counts for count-requested reads; production
semantics are verified through the actual API rather than an uncapped array.

A controlled future clock isolates each fixture window from older local history.
Fixtures are inert succeeded generations, zero-cost usage rows and provider
telemetry; no provider task, hold, payment, job or balance mutation is executed.
Specific generation/usage/dependency/Auth/profile cleanup reads back empty after
every case. The production baseline is a read-only aggregate: at October 6
20:14 UTC all three sixty-minute windows have zero rows. No live undercount or
missed provider incident is claimed.

The shared health output feeds the admin overview and operational monitoring.
This finding attaches to existing OPS-04, with JOB-02 cross-cutting evidence;
the 53-row ledger is unchanged. Private baseline/after/focused/count evidence is
under `.audit-evidence/backend-social/backend-health-*`. Exact-head Quality,
independently verified #386 parent, standard release and independent unchanged
schema/advisors/live verification remain. Full audit completion is not claimed.
