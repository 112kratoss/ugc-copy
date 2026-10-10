# Section 12Z — operational retention progress under row locks

A live transaction holding the oldest eligible row blocks the entire operational
retention RPC. Five actual local database regressions reproduce this separately
for job history, rate-limit windows, generation-completion jobs, provider events
and model-provider checks. With a bounded 350 ms test lock timeout, each call
fails; deletes in earlier phases roll back too. Without that timeout, the sweep
waits for the holder instead of cleaning other eligible rows. This is a local
contention reproduction, not evidence of a production incident.

Migration `20261010071057_skip_locked_operational_retention.sql` adds ordered
`FOR UPDATE SKIP LOCKED` selection to all five victim queries. The provider-check
phase locks base-table rows, preserving its separate latest-check-per-model
query. Retention windows, the caller's per-table deletion cap, active-work
protections and service-only grants are unchanged. Already applied migrations
are untouched.

Seven actual database controls pass: a locked oldest row in each of the five
tables, all eligible rows locked, and two overlapping sweep transactions. Each
phase advances within its one-row test cap. Locked rows survive and are eligible
on retry after release; concurrent transactions choose distinct victims. The
latest provider check survives every scenario. An all-locked sweep returns zero
deletions, with no claim that this means an empty backlog.

Fixtures are isolated to a replay database and dates before 1901. Sweeps execute
under the real service role inside rollback transactions, never committing a
prune of unrelated local rows. Independent connections hold the actual locks;
no query or lock response is mocked. Exact fixture cleanup checks all five
tables, the temporary catalog release and model identity. Only that random local
model fixture bypasses its immutable-delete guard during cleanup. No production
contention test, customer mutation or provider call occurs.

Two initial fixture failures (missing model identity and generated-ID handling)
were corrected before the five lock-timeout reproductions; these setup failures
are retained separately. The production-function failure evidence is
`retention-lock-reproduction.log`; `retention-lock-complete.log` passes seven
database and two migration controls. Clean replay, the existing retention policy
assertions and full SQL suite provide additional validation. Private evidence
lives under `.audit-evidence/backend-social/retention-lock-*`.

JOB-02 remains failed until the standard release and independent verification
complete. The change addresses row-lock contention; constraint/trigger poison
errors, other retention boundaries, managed lease fencing and broader job
coverage remain separate obligations.
