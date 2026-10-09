# Section 12U — recover a committed generation retry after resume failure

An actual template generation retry inserts its next attempt before updating the
run from `needs_attention` to `queued`. If that update is rejected, the service
ignored the database error and returned a successful response with a queued step
inside a stopped run. Repeating the original request returned early upon finding
the next attempt, leaving the run in `needs_attention` again.

Two local PostgreSQL regressions fail against the original service: the first
request does not report the rejected write, and repeating it does not resume the
run. The fault is injected at the SQL adapter's write boundary; all successful
operations, durable state, credit settlement and queue operations use real SQL.
Both pre-fix failures and fixture cleanup evidence are retained.

The service now checks the resume write and propagates its error. Replaying a
request whose next generation attempt is still queued resumes and enqueues that
existing attempt. It never inserts a second retry for the replay. Existing
terminal-run rejection and conditional run-status updates remain in force.

Four new database cases cover the rejected resume, successful replay with one
new provider acceptance and hold, enqueue failure followed by replay, and
cancellation before replay. The enqueue control explicitly removes its fixture
ticket (including the ticket the status-change trigger creates), then proves
the replay restores a pending ticket consumed by the real worker. A cancelled
run stays cancelled and starts no provider work. Repeated synchronization and
retry leave one next attempt and exact credit conservation.

All 45 database cases across the busy-retry and refused-start suites pass when
run sequentially, as in CI. An initial combined parallel invocation let the two
global queue processors consume each other's fixtures and failed two existing
claim-count assertions; that log is preserved. The corrected sequential run
passes in 26.46 seconds. All 58 focused service/component cases, application and
test typechecking, scoped lint and diff checks pass. The 31-case busy-retry suite
also verifies zero fixture users, generations, runs, steps, jobs, templates and
notifications after each case.

No schema, API shape or mobile runtime change is needed. Provider/admission,
polling and media boundaries remain controlled; these tests make no paid calls.
This fix restores an explicitly repeated retry request; it does not certify every
automatic recovery or transport failure window. WORKFLOW-02 is failed pending
exact-candidate CI and independently verified standard release. Broader workflow
coverage remains open. Private logs use `template-retry-resume-*` under
`.audit-evidence/backend-social/`.
