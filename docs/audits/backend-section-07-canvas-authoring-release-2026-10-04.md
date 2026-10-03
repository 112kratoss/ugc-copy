# Section 7H — canvas authoring release

October 4, 2026. PR #310 merged as
`3befe071092beb75436b2135af94626cb8b2042b` at 04:40:07 IST. No mobile store
release was active. Final PR Quality 37160265406 passed all four jobs on the
current-main candidate e5fd2247.

PR evidence: 6,952 web tests (208 skipped), 2,952 mobile, 45 browser, 1,960 SQL
assertions in 91 files, and 208 actual DB cases (two child-harness skips).
Exact-main Quality 37160881520 passed on attempt 2. Its first E2E attempt lost the
post-composer page execution context during navigation; the other 44 browser
cases passed. The failed-job rerun passed on the unchanged commit. Earlier main
Kling O3 layout failures did not reproduce in targeted/full local browser runs;
no UI change, test-threshold change or new retry setting was shipped.

Standard release 37161742833 passed at 23:28:57 UTC October 3 / 04:58:57 IST
October 4, including staged and protected live health. Independent checks confirm
exact build 3befe071, feed 200, admin login redirect 307 and unsigned webhook
rejection 401. Private evidence is in `canvas-authoring-release/` and the final
CI logs under `.audit-evidence/backend-section-07/`.

Publication, restore and PATCH now reject intervening canvas changes; a supplied
PATCH revision must match the initial read. Seventeen real SQL cases cover the
reproduced overwrites, decreasing revisions, unversioned rename, future revisions,
reverse order, ownership, deletion and rejected writes. All 137 local canvas tests
pass. See `backend-section-07-canvas-authoring-2026-10-03.md` for limitations.

The authoring defects are released. WORKFLOW-04 remains failed because the next
7I probe reproduced a separate share-import counter race. This is not a new scope
row. Historical revisions and broad workflow completion are not certified.
