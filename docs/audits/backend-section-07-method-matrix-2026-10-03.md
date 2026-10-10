# Section 7 — workflow method inventory and remaining evidence

Inventory captured October 3, 2026 at main 475fe2b7; evidence reconciled October 10. All 31 assigned route files resolve to
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
| Template read/cancel/approval/retry | 7A real SQL ownership/settlement; 12U retry recovery released; 12V atomic approval has 49 actual database controls, release pending; [12Y](backend-section-12-template-run-identity-2026-10-10.md) adds real Auth/PostgREST handlers, signed Storage bytes, foreign/unsigned/invalid identity, cross-run step IDs, duplicate actions, terminal refusal and temporary failure/retry | Proxy admission/session lifecycle, remaining action ordering, provider/Storage worker recovery |
| Template downstream execution | 7C two actual image/video start/settlement completion cases | Real node-input executor and Storage/provider transport; 7D adds two actual process-death/restart checkpoints |
| Template publication | 7B activation recovery released; [11S](backend-section-11-template-publication-release-2026-10-07.md) verifies 16 actual local Auth/PostgREST/Storage controls: draft ownership, publication revisions/rights/hash, committed reply loss, concurrent publish, copy rollback/retry and disable | Hosted expiry, publication/disable interleavings and long-lived orphan reconciliation beyond tested cleanup |
| Template input sign/finalize/start | 7K adds seven actual local Storage/PostgREST cases for upload bytes, malformed content, size mismatch, consumed tokens, replacement, lost reply and concurrent finalization/start; [7K fix released](backend-section-07-template-inputs-release-2026-10-04.md) | Hosted ownership/expiry, worker death, retained reservation recovery and broader run-state matrix |
| Canvas run start/approval/read | 7E actual SQL image/approval/video execution, duplicate start, partial refunds, pure GET, backpressure and failed/lost step-write recovery | 7F adds atomic approval rollback, concurrent approval, owner/role checks and lost acknowledgement; actual provider/Storage and canvas process-death matrix remain |
| Canvas collection/detail/history/restore/publish | 7H adds 17 actual authenticated SQL cases for publish/restore vs save, unversioned rename, competing restore, revision monotonicity, ownership, deletion and write rejection | [11Q/R](backend-section-11-workflow-inputs-release-2026-10-07.md) adds actual Auth/PostgREST collection/detail/history/publish/restore/delete, foreign ownership and malformed input coverage; remaining lifecycle/Storage boundaries and best-effort history limitations stay open |
| Share create/preview/import | 7I adds eight actual SQL cases for owner checks, source deletion, repeated copies, concurrent counting, counter failure and service-only grants; fix is released | 11Q adds actual Auth/PostgREST immutable preview and private-copy import; remaining input/lifecycle combinations and real Storage snapshot boundaries remain |
| Assistant message/proposal/apply/discard/state | 7G adds seven actual SQL discard/apply ordering, ownership and rejection cases; 7J makes the three private apply probes permanent and adds service/lost-acknowledgement/role/duplicate/no-op controls (17 DB cases with discard, #331 released) | Proposal generation/messages/state, HTTP identity and actual provider matrix remain |
| Blueprint | 11Q validates malformed roots/fields; 11R actual Auth/PostgREST billing covers replay, concurrent holds, exact refunds and committed reply recovery (25 combined authoring/billing cases) | Provider proposal generation and remaining resource/lifecycle boundary evidence |

Provider-dependent evidence remains GEN-04; real storage checks overlap
MEDIA-08/09. The ledger's WORKFLOW-02/03/04 remain open until both runners and the
remaining publication/input/authoring behaviors have bounded behavioral evidence.
