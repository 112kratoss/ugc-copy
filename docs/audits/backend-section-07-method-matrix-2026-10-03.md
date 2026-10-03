# Section 7 — workflow method inventory and remaining evidence

October 3, 2026. Baseline: main 475fe2b7. All 31 assigned route files resolve to
36 exported HTTP methods. This is an inventory, not 36 behavioral passes. It
refines the workflow portion of MAP-02 without closing that repository-wide row.

| Route | Methods |
| --- | --- |
| `/api/template-runs/[id]/approval-steps/[stepId]/approve` | POST |
| `/api/template-runs/[id]/cancel` | POST |
| `/api/template-runs/[id]/inputs/finalize` | POST |
| `/api/template-runs/[id]/inputs/sign` | POST |
| `/api/template-runs/[id]` | GET |
| `/api/template-runs/[id]/start` | POST |
| `/api/template-runs/[id]/steps/[stepId]/retry` | POST |
| `/api/templates/[id]/disable` | POST |
| `/api/templates/[id]/publish` | POST |
| `/api/templates/[id]` | GET, PATCH |
| `/api/templates/[id]/runs` | POST |
| `/api/templates/[id]/test` | POST |
| `/api/templates/mine` | GET |
| `/api/templates` | GET, POST |
| `/api/templates/validate` | POST |
| `/api/workflow-blueprint` | POST |
| `/api/workflow-canvases/[id]/assistant/messages` | POST |
| `/api/workflow-canvases/[id]/assistant/proposals/[proposalId]/apply` | POST |
| `/api/workflow-canvases/[id]/assistant/proposals/[proposalId]/discard` | POST |
| `/api/workflow-canvases/[id]/assistant` | GET |
| `/api/workflow-canvases/[id]/history/[entryId]/restore` | POST |
| `/api/workflow-canvases/[id]/history` | GET |
| `/api/workflow-canvases/[id]/publish` | POST |
| `/api/workflow-canvases/[id]` | DELETE, GET, PATCH |
| `/api/workflow-canvases/[id]/run` | POST |
| `/api/workflow-canvases/[id]/runs/[runId]/approval-steps/[stepId]/approve` | POST |
| `/api/workflow-canvases/[id]/runs/[runId]` | GET |
| `/api/workflow-canvases/[id]/share` | POST |
| `/api/workflow-canvases` | GET, POST |
| `/api/workflow-shares/[shareId]/import` | POST |
| `/api/workflow-shares/[shareId]` | GET |

## Evidence by behavior

| Behavior | Evidence available | Remaining proof |
| --- | --- | --- |
| Template read/cancel/approval/retry | 7A real SQL ownership, settlement, duplicate actions and checkpoint conflicts; pure-read regression | HTTP identity/lifecycle combinations and broader action ordering |
| Template downstream execution | 7C two actual image/video start/settlement completion cases | Real node-input executor and Storage/provider transport; 7D adds two actual process-death/restart checkpoints |
| Template publication | 7B committed activation/lost-reply regression | Successful and rejected live Storage publication, stale revisions, enable/disable races, orphan reconciliation |
| Template input sign/finalize/start | Existing ownership and upload reservation code; source reviewed | Actual Storage upload/replacement/expiry, lost reply and owned run-state transitions |
| Canvas run start/approval/read | Prior ownership/start admission and recent upstream retry fixes | Full actual SQL canvas execution, partial failure, duplicate start, recovery and billing matrix |
| Canvas collection/detail/history/restore/publish | Export inventory and existing service tests | Cross-user, stale revision and concurrent write/restore behavior at SQL/HTTP boundaries |
| Share create/preview/import | Owned source lookup, sanitized snapshot, private draft insertion and existing unit route tests | Actual user-role SQL, stale share/source lifecycle and duplicate import semantics |
| Assistant message/proposal/apply/discard/state | Owned proposal/canvas reads and atomic revision-guarded apply RPC; existing unit tests | Actual role/revision/concurrency matrix and provider-free proposal fixtures |
| Blueprint | Export inventory | Method validation, resource bounds and provider boundary evidence |

Provider-dependent evidence remains GEN-04; real storage checks overlap
MEDIA-08/09. The ledger's WORKFLOW-02/03/04 remain open until both runners and the
remaining publication/input/authoring behaviors have bounded behavioral evidence.
