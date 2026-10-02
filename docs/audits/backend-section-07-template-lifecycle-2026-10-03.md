# Section 7A — template lifecycle and late-refund projection

Date: October 3, 2026. Baseline: `dd3d6c13` (6S merge). Status: initial lifecycle
matrix and a reproduced reporting fix verified locally; final CI/release pending.
WORKFLOW-02/03/04 remain open for the broader matrix.

## Real-database checks

The existing template busy-retry fixture runs the actual template worker/start
service, service-role SQL, queued jobs, generation holds and settlement against
isolated Postgres on port 55322. It now adds these checks:

- Cancel a queued run twice: no provider start, generation row or credit hold.
- Cancel with two active generations: holds remain until actual failure settlement;
  repeated settlement refunds each once, and repeated cancellation cannot restart.
- Reject a foreign user's cancellation without changing the run or balance.
- Settle both image steps successfully, reach approval gates, approve once and
  reject duplicate/foreign approval without another charge.
- Cancel after settled image steps: successful work remains successful, waiting
  gates are cancelled, the charge remains and terminal retry is rejected.
- Retry a checkpoint twice: one next generation attempt and one next approval
  gate; no credit hold until the worker starts it. A subsequent tick does not
  start it twice. Current and prior successful attempts all count toward cost.
- Two separate service-role connections competing to approve one gate produce
  one success and one conflict. Two concurrent retries create one next attempt
  and no extra hold.

All 13 cases pass, including the original five busy-retry cases. The database,
state transitions and hold/refund behavior are real. Provider submission/status
sync, media transport and the node executor's image-start boundary are controlled
fixtures. This does not certify real provider delivery, downstream video execution,
full run completion or every approval/retry/cancel interleaving. Dedicated route,
Storage, process-restart, canvas and template-publication coverage remains pending.

## Reproduced stale credit total

Two image generations each reserve eight credits. Cancel the run while both are
processing, then settle both failures through the actual SQL function twice. The
user balance returns to its original 500 exactly once per generation, but the
run response still reports 16 credits used instead of zero. The cached run summary
is not refreshed after cancellation, and `toRunDto` preferred any nonzero cached
value over the generation settlement state already loaded for the response.

The DTO now derives its total from every generation attached to the run. This
includes earlier retry attempts; it does not count only the latest visible steps.
The existing generation-cost calculation uses actual cost where recorded and
excludes failed generations without actual cost. The generation deletion service
excludes template-linked rows from ordinary creation deletion, preserving those
run records. A generation-query failure still rejects the request; the change does
not convert a failed query into zero. Historical out-of-band row deletion is not
reconciled by this fix.

The regression exercises the pure owned GET directly after late settlement and
then checks sync and repeated cancel responses. All report zero with the run
still cancelled and the balance unchanged. Successful/retried work still reports
its complete cost. No provider poll, execution, balance mutation or run-summary
write is added to GET; response shape and web/mobile contract remain unchanged.

## Verification

Before-fix real-DB assertion: expected zero, received 16. After-fix: 13 DB cases
pass. The targeted existing template/catalog/read-contract suites pass 45 cases.
The full web suite passes 6,648 tests (137 skipped, including the 13 DB tests
run separately). App/test TypeScript projects and targeted lint pass. Independent
SQL readback finds no remaining audit templates or runs. CI and deployment are
pending; their final results are recorded in the handoff.
Private failures, successful runs and the remaining matrix are preserved in
`.audit-evidence/backend-section-07/`. No customer data, paid provider transaction,
SQL schema change or mobile runtime change is involved.
