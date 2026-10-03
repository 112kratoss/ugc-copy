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
| Canvas run start/approval/read | 7E actual SQL image/approval/video execution, duplicate start, partial refunds, pure GET, backpressure and failed/lost step-write recovery | 7F adds atomic approval rollback, concurrent approval, owner/role checks and lost acknowledgement; actual provider/Storage and canvas process-death matrix remain |
| Canvas collection/detail/history/restore/publish | 7H adds 17 actual authenticated SQL cases for publish/restore vs save, unversioned rename, competing restore, revision monotonicity, ownership, deletion and write rejection | Full collection/detail/delete/history read matrix, HTTP/Storage boundaries and best-effort history limitations remain |
| Share create/preview/import | Owned source lookup, sanitized snapshot, private draft insertion and existing unit route tests | Actual user-role SQL, stale share/source lifecycle and duplicate import semantics |
| Assistant message/proposal/apply/discard/state | 7G adds seven actual SQL discard/apply ordering, ownership and rejection cases; private SQL apply probes cover stale revision, failed history rollback and competing proposals | Proposal generation/messages/state, lost acknowledgement, HTTP identity and actual provider matrix remain |
| Blueprint | Export inventory | Method validation, resource bounds and provider boundary evidence |

Provider-dependent evidence remains GEN-04; real storage checks overlap
MEDIA-08/09. The ledger's WORKFLOW-02/03/04 remain open until both runners and the
remaining publication/input/authoring behaviors have bounded behavioral evidence.
