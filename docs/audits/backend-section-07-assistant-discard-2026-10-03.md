# Section 7G — assistant proposal discard consistency

October 3, 2026. Candidate follows 7F, incorporating main 6df13e5d.
Local checks pass; CI and deployment pending. WORKFLOW-04 remains open.

## Reproduction and change

The discard service loaded an owned proposal, then unconditionally wrote
`discarded`. It could overwrite an already applied proposal, including an apply
committing after its initial read. It also ignored ordinary database errors and
returned success after a rejected write. This left persisted state and the
response inconsistent, or represented an applied graph as a discarded proposal.

Three actual authenticated SQL cases fail on the baseline. The apply action is
the existing atomic SQL function on a second connection; it commits a changed
canvas and history before the stale discard update resumes. A PostgreSQL trigger
independently rejects the fixture's discard write. Candidate code now checks
ready state and updates only the matching owner, canvas and still-ready proposal.
It returns the row actually written. Errors produce 500; a lost race/deleted row
or non-ready proposal produces 409. Missing schema retains 503 behavior.

## Verification

Seven database cases pass: already-applied state, apply-after-discard-read race,
real write rejection, deletion between read/write, duplicate discard timestamp
preservation, foreign authenticated identity despite a supplied owner ID, and
successful discard preventing later apply. Applied canvases retain revision 5;
the discard cannot overwrite the applied proposal. Nine existing focused service
cases, app/test typechecks and targeted lint pass. CI runs the actual SQL suite
in a dedicated step after the other queue/lifecycle fixtures.

All fixture users, canvases and injected triggers are cleaned up. The SQL adapter
uses real queries under authenticated RLS; it does not certify PostgREST transport
or the browser interaction. No assistant model is called. Other assistant message,
proposal generation, share/import, history and restore paths remain separate work.
A committed write whose reply is lost can report failure; this patch makes no
exactly-once transport guarantee and does not rewrite historical proposal rows.

Private before/after logs are under `.audit-evidence/backend-section-07/`:
`assistant-discard-before.log`, `assistant-discard-after.log`,
`assistant-discard-final.log`, and `assistant-discard-focused.log`.
