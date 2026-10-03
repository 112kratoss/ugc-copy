# Section 7G — assistant discard release verification

Verified October 4, 2026 (Asia/Kolkata). PR #308 merged as
`17dfbbc5bb8bf27c0e03f4871c60453feaea577a` on October 3 at 19:01:14 IST, after
PR Quality 37125585448 passed all four jobs and the mobile release check was idle.
Its first exact-main Quality 37126464670 was canceled when #309 advanced main;
this is not recorded as a pass.

Production subsequently advanced through other changes. Successful standard
release 37157112250 deployed descendant
`ea49b373cffcb222d961e5fc1dbd2a81ef14533f`, after exact-main Quality 37156444155
passed. Independent live checks on October 4 confirm that exact build, feed 200,
admin login redirect 307 and unsigned webhook rejection 401. The release also
passed staged and protected live health. No manual deployment was used.

Discard now updates only a still-ready owned proposal, returns the stored row,
and reports errors and lost races. The seven actual SQL regressions cover
apply/discard ordering, rejected writes, deleted rows, duplicate timestamps and
foreign identities. See `backend-section-07-assistant-discard-2026-10-03.md`.
Historical proposals were not rewritten and no assistant provider was called.

WORKFLOW-04 remains failed for the separately reproduced 7H authoring races until
that fix releases; its broader sharing, assistant and input matrix also remains
open. Private CI logs and live readbacks are retained under
`.audit-evidence/backend-section-07/assistant-discard-release/` and the final
assistant-discard CI logs.
