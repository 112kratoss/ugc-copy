# Section 12X — workflow scheduler discovery and durable outcomes

Nine actual local PostgREST/SQL cases pass for the workflow scheduler's managed
entrypoint. No application or schema fix was required. The suite is wired into
the existing sequential Supabase API CI job.

Seven injected HTTP failures cover pending workflow lookup, stale heartbeat
lookup, missing-heartbeat lock lookup, due-template RPC, stranded-workflow RPC,
stranded-template lookup and template queue pruning. Each produces a failed
managed result and a durable failed job record with the error. None invokes
either queue processor. Removing the fault permits an empty retry with its own
durable skipped record.

The empty-work control records `no_due_workflow_run_steps`. The contention case
creates an actual queued template and pending ticket, then acquires the managed
workflow lease as another worker. The invocation records `already_running`,
preserves the lease owner, and leaves the pending ticket unclaimed with zero
attempts. After removing only the fixture run and releasing its lease, the
next invocation correctly records no work. It does not claim paid-work recovery.

The actual managed wrapper, work-discovery helpers, lease RPCs, run persistence
and queue prune RPC execute against the isolated local stack. External origins
are rejected by the client transport. Cleanup independently verifies zero fixture
users, runs, jobs, history and owned locks. A fixed safe prune-window timestamp
avoids unrelated job-history retention; the template queue has no preexisting
terminal fixtures requiring preservation.

All nine cases pass in 29.48 seconds; test typing, scoped lint and diff checks
pass. Two initial fixture mistakes are retained in private logs: an incorrect
table name, then an assumption that inserting a queued run automatically creates
a ticket. The final fixture calls the real enqueue RPC explicitly. Neither was
a product failure.

JOB-01/02 remain untested for the wider per-job execution, budgets and lease
fencing matrix. These controls prove scheduler discovery and reporting only.
Candidate CI and release inclusion remain pending. Private evidence is
`workflow-managed-*` under `.audit-evidence/backend-social/`.
