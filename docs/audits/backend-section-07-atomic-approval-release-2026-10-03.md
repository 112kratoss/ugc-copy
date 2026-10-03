# Section 7F — atomic checkpoint approval release

October 3, 2026. PR #294 merged as
`9416008a4d684e1451b40ddd6bf0fb9f084b87ed` at 18:44:56 IST. No mobile store
release was active. Final combined-main PR Quality 37124830807 and exact-main
Quality 37125525853 passed all four jobs.

Exact-main evidence: 6,887 web tests (184 skipped), 2,932 mobile tests, 36 browser
cases, 1,960 SQL assertions in 91 files and 184 actual database cases (two harness
skips), including 14 canvas lifecycle cases. Standard production release
37126198484 passed its first attempt at 13:30:10 UTC / 19:00:10 IST, including
staged and protected live health. Independent exact-build, feed 200, admin login
redirect 307 and unsigned webhook rejection 401 checks pass on 9416008a.

Approval now commits the gate result, run continuation and durable wakeup in one
transaction. Real SQL reproduces the prior half-approved strand and verifies
rollback, competing approvals, role/ownership restrictions, lost acknowledgement
and terminal-state refusal. See `backend-section-07-atomic-approval-2026-10-03.md`.
The production migration ships through the normal release workflow.

This release and the earlier 7E persistence release remove the two reproduced
canvas defects from WORKFLOW-02. That obligation returns to untested: the broader
canvas process-death and provider/Storage matrix is still open. Historical rows
were not rewritten. Private logs and independent live results are retained under
`.audit-evidence/backend-section-07/canvas-approval-release/` and the main-CI logs.
