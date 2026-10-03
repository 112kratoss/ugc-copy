# Section 7F — atomic canvas checkpoint approval

October 3, 2026. Candidate follows Section 7E (`cce105f3`). Local verification;
clean migration replay, final CI and release pending. WORKFLOW-02/03 remain open.

## Reproduction

Canvas approval previously wrote the gate, then the run, then enqueued a ticket.
A PostgreSQL trigger rejecting the second write leaves the gate `succeeded`,
the run `awaiting_approval`, and no live job. Repeating approval returns 409;
the stalled-run adopter considers processing runs only. Even after aging the
fixture run past the adoption threshold, the real worker does not start its
video. The paid source image remains complete, but its branch is stranded.

The isolated before probe records those two durable statuses and fails its
expected downstream-generation assertion (one generation instead of two).
All changes are confined to the fixture; the injected trigger/function are
removed in finally. This is an actual SQL rejection, not a process-death claim.

## Change

`approve_workflow_checkpoint` locks the owned run and its checkpoint, validates
current run/gate state and the stored graph/preview, then commits gate approval,
run continuation and the namespaced wake ticket in one transaction. A failure
in any write rolls all three back. Concurrent requests cannot both approve.
Only service_role can execute it; SECURITY INVOKER and an empty search_path
avoid new privilege elevation. The existing owner-scoped request read still
runs before crossing into the internal mutation client. Other authenticated
workflow compatibility grants are unchanged.

The app preserves its initial validation and uses the atomic RPC for mutation.
If a committed reply is lost, the action may still report an error, but its
queued work continues; a later duplicate approval keeps the existing 409
behavior. The change does not retrospectively repair already stranded runs.
The migration adds one function and can precede deployment of the new caller.

## Evidence and limits

The real database suite now has 13 cases. Six added cases verify run-update
rollback, queue-insert rollback, two concurrent service-role connections,
foreign owner/canvas and role rejection, a lost committed RPC reply, and a
terminal-run guard. The original seven Section 7E lifecycle/billing cases still
pass through the new approval implementation. Independent database readback
shows no leftover fixture runs or fault triggers. The focused runner/queue and
migration suite passes 67 tests; app/test typechecks and targeted lint pass.

Provider network/admission/status synchronization, URL resolution and media
persistence remain controlled fixtures. Actual SQL runs through a typed adapter,
not PostgREST transport. Full clean migration replay is required in CI before
merge; local evidence applies this new SQL to the existing isolated audit DB.
Historical stranded-run reconciliation, all authoring races, actual Storage and
canvas process death remain separate evidence. No broad workflow closure.

Private logs: `.audit-evidence/backend-section-07/canvas-approval-before.log`,
`canvas-approval-after.log`, `canvas-approval-final.log`, and
`canvas-approval-migration.log`. No real customer or provider charges.
