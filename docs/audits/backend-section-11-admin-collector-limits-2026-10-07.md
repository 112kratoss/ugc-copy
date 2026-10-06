# Section 11E — admin collectors across the actual API row ceiling

Two regressions reproduce through actual PostgREST with its 1,000-row ceiling.
The revenue collector requests 2,000 rows per rail but reports 1,000 of 1,001
web orders with `ordersTruncated: false`. The system collector likewise misses
the newest failed run after 1,000 older successful runs, reporting no failures
and an outdated last status. Baseline: two failures, seven passing controls.

Revenue now issues bounded range queries with exact counts, up to its existing
2,000-row budget for each rail. A deterministic timestamp/id order preserves
static page membership. The existing truncation warning uses the actual count,
so 2,000 rows are complete while 2,001 rows disclose the 2,000-row bound. A failed
later page rejects the report instead of silently accepting an incomplete sum.
This remains a bounded, multi-request report; it is not an atomic snapshot of
concurrent purchases. Wallet aggregation and other collector semantics remain
separate audit work.

The daily job summary moves to `admin_job_run_summary(timestamptz)`, grouping
counts and latest status in one stable SQL snapshot. Execute privilege is
restricted to `service_role`; anonymous and authenticated roles are denied,
and the definer search path is fixed. Equal timestamps use the run id as a
deterministic tie breaker. No customer, payment, job execution or mobile behavior
changes. The migration is CLI-stamped `20261006190707`; release must apply it
before deploying the calling runtime through the standard workflow.

All 14 actual API/SQL cases pass: the two failures, 1,000/2,000/2,001 boundaries,
a second-page 503 outage and anonymous summary denial, plus prior purchase
exclusions. The outage case allows the real SDK's 1/2/4-second retry backoff;
the initial five-second test allowance timed out and was corrected to 20 seconds.
All 25 focused cases, app/test types and scoped lint pass. A clean replay in the
owned isolated replay stack passes all 2,174 assertions across 101 pgTAP files,
including eleven new RPC privilege, window and tie-breaker assertions.
Specific transaction, job, Auth and profile fixture cleanup reads back empty.

The separate API fixture has no migration directory, so its CLI migration-up
attempt refused to change the database. Only the new function was subsequently
installed in that owned loopback fixture for the API tests; its ledger was not
repaired. The complete clean replay independently verifies the migration file.
The primary local stack and production schema were not modified by these tests.

A read-only production aggregate at October 6 19:10:59 UTC found 939 daily runs
across twelve job names with zero failures, below the reproduced local ceiling.
No current production missed failure or incorrect revenue incident is claimed.
Private before/after, clean replay and aggregate evidence is under
`.audit-evidence/backend-social/`. Exact-head CI, the verified parent releases,
standard deployment and independent schema/function/privilege checks remain.
OPS-04 stays failed for known pending defects; the complete audit remains open.
