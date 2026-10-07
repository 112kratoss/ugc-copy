# Section 11P — canvas worker interruption and billing recovery

October 7, 2026. Runtime baseline: independently verified main
`3f04cb16f9435d8a20735a2ac7ca7514db9ddb3a`. This adds permanent evidence to
WORKFLOW-02/03 without a runtime or migration change. Full candidate CI and
release verification remain required.

Three separate Vitest worker processes run the actual canvas runner, node
resolver, generation start service, queue and service-role SQL against the owned
database on port 55332. Each writes a barrier after a committed boundary, then
the parent sends SIGKILL to that owned process group and verifies its exit signal.
The interruption points are queue claim, provider-task attachment before step
linking, and committed step linking before acknowledgement.

An independent database connection confirms the processing lease and durable
generation/step state after death. A fresh worker claims nothing while the lease
is current. Only the fixture's timestamps are then aged beyond 300 seconds;
the next fresh process reclaims it. This is actual process death and restart,
with controlled lease age, not proof of 300 seconds of elapsed wall time.

Each recovered run has exactly one image generation and one recorded provider
acceptance. If acceptance preceded death, its original generation and hold are
preserved; recovery links that existing generation without submitting or charging
again. Successful duplicate image settlement reaches the approval gate. Approval
starts one downstream video and holds its quoted cost once. Duplicate video
failure settlement refunds only that video; the successful image remains charged,
and the run ends failed. A later immediate worker claims no deferred ticket.

All three cases and the full 21-case canvas database suite pass. The child-only
test is intentionally skipped in the parent run and executed by the three child
processes. Existing approval failure, concurrent approval, backpressure, pure
GET and exhausted-job controls still pass. Test types, scoped lint and diff
checks pass. After every case, an independent connection confirms zero fixture
Auth users, profiles, generations, canvases, runs and queue rows. The test harness
refuses to start the interruption probe if unrelated live fixture jobs exist.

The first run passed recovery through final settlement but failed a test
assertion for a nonexistent response field. The assertion was corrected to the
actual stored generation settlement state; no application defect or speculative
fix is claimed. Both logs remain private in `.audit-evidence/backend-social/`.

Provider submission/admission/status synchronization, media URL resolution and
input persistence remain controlled boundaries, as in the existing canvas suite.
There is no paid request, real Storage delivery, production contention or customer
balance change. Actual PostgREST transport, provider/Storage interruption and the
remaining action/method matrix still need evidence. WORKFLOW-02/03 remain
untested for that broader scope, and the overall ledger stays unchanged.
