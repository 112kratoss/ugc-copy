# Section 7D — actual template worker termination

October 3, 2026. No runtime change. Extends the Section 7C database fixture with
two real SIGKILL checkpoints. Final PR/main CI and release evidence are pending.

The parent commits a test run and explicitly enqueues its durable job. A child
Vitest process runs the real template job processor and SQL as service_role.
The child writes a barrier after the selected RPC commits, before returning its
answer to the processor. The parent kills that isolated process group with
SIGKILL, including the worker and its open database connection.

- After `claim_template_run_jobs`: the durable job remains processing, with no
  generation or charge yet. A fresh worker claims zero while its lease is live.
- After `attach_generation_provider_task`: exactly one charged generation and
  its provider task survive. A fresh worker again respects the live lease.
- For each case, only that fixture's locked_at and heartbeat_at are advanced by
  301 seconds. A new process reclaims the job, reaches two processing images and
  defers normally. There are exactly two provider submissions total, two holds
  and the matching remaining balance. Another immediate process claims zero.

All 21 database cases pass (one child-harness skip), with test TypeScript and
lint passing. Independent readback finds zero fixture templates/runs. Child
processes and temporary directories are cleaned in finally blocks. The first
probe omitted explicit enqueue (the fixture inserts a queued row whereas the
production start transition enqueues); it was corrected before certification.
That harness failure is retained in the raw evidence.

Provider acceptance is a recorded local fixture; polling and media transport are
mocked. The node executor calls real image/video start services with controlled
settings. Lease time is deliberately advanced; this is not a 301-second wall-clock
wait or a production TTL measurement. These two checkpoints do not certify every
worker interruption, real provider acknowledgement loss, canvas execution or
full Storage cleanup. WORKFLOW-02/03 remain open for those boundaries.

Raw logs: `.audit-evidence/backend-section-07/template-worker-kill-*.log` and
`worker-kill-cleanup.log`. The permanent regression lives in
`src/__tests__/template-run-step-busy-retry-database.test.ts`.
