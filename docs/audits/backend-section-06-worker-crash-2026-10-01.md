# Section 6G — actual generation worker termination

Status: locally verified; PR/CI pending. No new production defect or runtime
change in this batch. This extends the preceding SQL and exception-based tests
with actual process death and fresh-process recovery.

## Scope and results

Nine permanent cases run the production services/processors against committed
local PostgreSQL fixtures. A child process stops at a controlled boundary; the
parent sends SIGKILL to its isolated process group and waits for termination.
Recovery runs in a newly spawned process with a new lease owner. A thrown mock
exception is not used as a substitute for process death.

| Crash boundary | Verified outcome |
| --- | --- |
| Reservation committed, before provider dispatch | Same-key requests remain pending; no provider submission; expiry restores the marker and refunds once |
| Provider accepted, before task attachment | Same-key request cannot duplicate work; signed callback attaches in a new process; replay reuses one provider task and hold |
| Completion lease claimed | No takeover before expiry; new owner completes after controlled expiry |
| Output-import job enqueued, completion job unfinished | Recovery reuses one durable import and completes the callback job |
| Import lease claimed | No takeover before expiry; new owner imports and settles |
| Upload stream interrupted | Fresh worker imports, settles and creates one notification |
| Storage write completed, before SQL settlement | Retry writes the same storage path; one final object, settlement and notification |
| SQL settlement committed, job unfinished | Recovery skips another upload and completes the job with one notification |
| Notification recorded, job unfinished | Recovery reuses the notification and completes the job |

The fixture now starts through the actual reservation RPC: total credits 500 and
promotional credits 200 become 380 and 80 after a 120-credit hold. Successful
recovery preserves both compartments; expiry returns them to 500 and 200 once.
Media imports use the real staging implementation and local filesystem bytes.
The storage adapter records actual stream consumption and stable-path writes.
Notification history and deduplication use their real application code and SQL;
fixture push preferences are disabled, so no external push is sent.

Lease timestamps are advanced on isolated fixture rows by 301 seconds, and the
start expiry by 46 minutes. This proves selection and recovery after those
thresholds, not a five- or forty-five-minute wall-clock soak. Original workers
are dead before a new owner runs; overlapping live-owner races remain covered
separately by Section 6A's SQL tests.

## Actual HTTP restart checks

The isolated Next server was also killed as a process group and restarted. Its
provider/Auth/REST bridge remained alive to retain the simulated provider's
accepted task and committed local PostgreSQL state.

After provider acceptance, the HTTP connection disconnects with a pending,
unrefunded generation. New-process same-key retry returns 409. A signed callback
to the restarted route returns 200 and resumes processing; same-key replay then
returns 200. Exactly one provider request and one 8-credit reservation occur;
total/promotional balances remain 492/192 from 500/200.

After reservation but before dispatch, killing the route produces no provider
request. New-process retry returns 409. Following controlled expiry, a fresh
reaper process refunds once, restoring 500/200. The existing reaper and SQL are
used; no production balance or provider was touched.

Auth is stubbed for a synthetic identity and provider HTTP is redirected locally.
Every nonlocal fetch is blocked. This does not prove genuine Kie/edge delivery,
production Auth, remote object-store interruption semantics or real push delivery.

## Verification and residuals

All 64 generation recovery DB cases pass together (55 existing plus nine process
cases). The child-only entry test is intentionally skipped in the parent run.
Test typing and targeted lint pass. Quality's clean-replay database job now runs
this file alongside the other recovery suites. General web CI skips these cases
without a local database. No migration or mobile runtime/OTA change is needed.

Initial fixture attempts failed due to Node-vs-jsdom setup, SQL parameter type
inference, and assuming a manually inserted generation preserved promotional
credits. Those are harness errors, saved separately; they are not product defect
reproductions. The corrected suite uses actual reservation semantics and passes
without a production code patch.

SIGKILL during upload or after storage/SQL writes can leave a `remote-media-*`
staging directory because `finally` never executes. Successful retry removes its
own staging directory but does not remove the dead worker's directory. The
fixture records this residual and confines it to an isolated TMPDIR, then removes
it in parent cleanup. This is not a claim of bounded disk usage or cleanup after
host reuse. Assess stale-file cleanup and disk-budget behavior next, with ownership
and active-file protections before proposing a deletion policy.

Further open boundaries include actual object-store/network interruption,
provider-accepted work followed by worker death, grace expiry and a late callback
in one process-death scenario, deployment/container replacement, and genuine
provider/edge/push delivery. Section 6F covers marker recovery and late callback
reconciliation without process death; do not conflate the evidence.

Private evidence: `.audit-evidence/backend-section-06g/`. Local HTTP workers are
stopped and fixture rows are removed. The broader audit remains open; this is not
whole-subsystem certification or a completion percentage.
