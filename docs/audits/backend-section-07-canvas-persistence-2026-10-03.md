# Section 7E — canvas execution and accepted-task persistence

October 3, 2026. Baseline: main `f6a3d3b1` (Section 7C/D). Local candidate;
CI and release pending. WORKFLOW-02/03 remain open.

## Reproduced failure

After a canvas image node's provider task is accepted and attached to its
reserved generation, the runner saves the generation ID on the workflow step.
That write shared a catch block with generation execution. A rejected database
write therefore took the generation-failure path: the step and run became failed,
the queue ticket completed successfully, and the real generation remained
processing with its 8-credit hold. The workflow no longer followed its output.

A PostgreSQL trigger rejects only the fixture run's first generation-link write.
The baseline reports `advanced: 1, retried: 0`, a failed run, and one processing
8-credit generation. This is an actual SQL write rejection, not a mocked database
error. The trigger and function are removed in a finally block.

The success-result persistence now sits outside the generation-failure catch.
A write error reaches the durable job processor, which schedules its existing
retry. The node's stable request key reconnects the existing generation. A lost
reply after a committed write similarly retries and reads the durable link.
Generation refusal, backpressure and held-submission handling are unchanged.

## Evidence

Seven isolated database cases exercise actual canvas initialization, queue
claim/defer/retry, graph input resolution, code-catalog quotes, the real image and
video node executor, start services, ownership-scoped authenticated reads and
approval, and service-role settlement:

1. Duplicate run start creates one run; image -> approval -> video completes;
   duplicate terminal callbacks do not change the balance twice.
2. Failed downstream video refunds once and retains the successful image charge.
3. Failed source blocks approval/video and refunds only the source hold.
4. Rejected step-link write retries and reconnects one accepted generation.
5. Committed step-link write with lost acknowledgement is independently read
   through the admin connection, then recovered without another submission.
6. Provider backpressure refunds the refused hold and defers without spending a
   queue attempt; a later tick admits one active generation.
7. Repeated run GETs leave the stored run, steps and tickets byte-equivalent while
   the completed source waits for its worker; no provider call occurs on GET.

All seven pass locally; 65 existing runner/job-processor cases also pass. App/test
typechecks and targeted lint pass. Independent SQL readback shows no remaining
fixture canvases, runs or fault triggers. The
new suite has a dedicated sequential step in the clean-replay CI database job,
so its unscoped queue claims do not consume another test file's fixtures.

## Limits

Provider network responses, admission, status synchronization, URL resolution
and media persistence are controlled fixtures. SQL adapters execute real queries
but do not exercise PostgREST transport. This does not certify actual Storage,
provider delivery, full catalog pinning, all canvas authoring/approval races or
canvas process-death recovery. Section 7D's actual kill cases concern templates.
The trigger injects a write rejection, not a PostgreSQL process crash. Run
idempotency is tested through sequential duplicate starts here; broader concurrent
starts remain covered separately by the SQL initializer tests.

Private logs: `.audit-evidence/backend-section-07/canvas-link-before.log`,
`canvas-link-after.log`, `canvas-lifecycle-final.log`, and `canvas-focused.log`.
No real customer balances or paid providers were used.
