# Section 12T — template worker death before provider submission

Two additional PostgreSQL-backed cases pass for a worker killed after
`start_template_generation` commits its credit hold and before any provider
submission. The permanent template recovery suite now passes 27 cases; its
worker-only entry is skipped in the parent process and executed by child workers.
No application or schema fix was required.

Each new case launches the actual job processor and generation start service in
a separate Node process. The SQL adapter pauses after the committed start RPC;
the parent sends SIGKILL and verifies the exit signal. At that point there is
one pending generation, its exact credit hold, and zero recorded provider calls.
A restart cannot claim the still-leased job. After aging only that fixture's
lease, a fresh worker claims it, retains the existing pending generation and
starts the other image once. A further restart creates no duplicate generation.

The actual stalled-generation reaper leaves the young pending hold alone. After
aging only that generation's timestamp beyond the 45-minute cutoff, it invokes
template start-failure settlement, refunds precisely that hold, fails its step
and creates one notification. Repeating the reaper changes neither the balance
nor notification count. Retrying through the actual template service creates
one new attempt and provider call; repeated synchronization creates neither
another generation nor another charge.

The second case cancels the run before stale settlement. Cancellation retains
the two active holds; the reaper then refunds the taskless generation while
retaining the charge for the other accepted task. The run and its steps remain
cancelled, retry is rejected with `RUN_TERMINAL`, and repeated cancellation or
synchronization starts no work and changes no balance.

The two existing death boundaries (job claim and provider-task attachment) also
pass. Every case independently reads back zero fixture users, generations, runs,
steps, jobs, templates and notifications after teardown. The full suite passes
in 18.17 seconds; test typing and scoped lint pass. Private logs are
`template-presubmit-recovery-*` under `.audit-evidence/backend-social/`.

Provider submission, admission, polling and media transport are controlled
boundaries; no paid provider or actual Storage request is made by this suite.
Worker execution, queue leases, template services, holds, settlement and
notification persistence use their real code and local PostgreSQL. Deliberate
fixture timestamp aging proves cutoff behavior, not real elapsed TTL. This
extends WORKFLOW-02/03 without closing their wider action, provider and Storage
recovery requirements. Candidate CI and release inclusion are pending.
