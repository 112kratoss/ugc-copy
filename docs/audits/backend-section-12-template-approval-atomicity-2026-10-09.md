# Section 12V — commit checkpoint approval and durable execution together

Approving a checkpoint previously committed the step before updating the run
and enqueueing its worker. A rejected run update was ignored: the service
returned success with an approved checkpoint inside a run still waiting for
approval. Repeating the approval was refused because the step had succeeded.

Two regressions reproduce this against real PostgreSQL. A disposable trigger
rejects the fixture run's update after the step write. One test proves false
success; the other proves the checkpoint stayed approved instead of rolling
back. The trigger and function are removed in `finally`, and all fixture data is
independently checked after teardown. Original failures are retained privately.

The new service-only `approve_template_checkpoint(uuid,uuid,uuid)` function locks
the owned run, then its current checkpoint, using the same lock order as atomic
checkpoint retry. It checks ownership, terminal state, latest attempt, approval
readiness and output presence inside the transaction. Approval timestamps, run
resumption and durable queue creation commit together. Any SQL failure rolls
the operation back. The service preserves existing successful response shapes
and error codes; a concurrent terminal transition is now rejected before the
checkpoint changes.

Four fault cases reject either the run update or queue write and verify errors
and rollback. Removing each fault permits approval and exactly one downstream
provider acceptance. Existing concurrent approvals still produce one winner;
approval versus retry/cancellation/abandonment controls also pass. Provider
submission, admission, status polling and Storage transport are controlled;
worker, services, queue, state and financial writes use actual SQL.

Validation:

- 49 database cases pass on both the existing isolated stack and clean replay.
- 265 template tests pass; 79 environment-gated tests are skipped in that run
  and are not counted as evidence. The database cases above ran explicitly.
- Clean replay passes all 2,376 pgTAP assertions in 112 files, including sixteen
  new ownership, privilege, stale-attempt, terminal-state and queue checks.
- Application/test typing, scoped lint and diff checks pass.

Migration `20261009163235_atomic_template_checkpoint_approval.sql` was created
with the pinned CLI and adds one invoker function and service-role execution
grant. The standard release must apply it before staging the application. It
does not modify existing records, tables or other grants. Production impact
inventory, rollback controls, candidate CI and release verification remain
pending. WORKFLOW-02 remains failed until this and the preceding retry fix are
verified; broader workflow coverage remains open.

Private evidence is `template-approval-*` under
`.audit-evidence/backend-social/`. SQL fault injection is local only.
