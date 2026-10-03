# Section 7I — concurrent workflow share import counts

October 4, 2026. Candidate follows released/merged authoring work in #310.
Deployment is pending. WORKFLOW-04 remains failed for the reproduced counter race;
its broader sharing/assistant/input matrix remains incomplete.

## Reproduction and behavior

Two actual import service calls read the same share count. Both create and retain
a private draft and history, but their later count+1 updates overwrite each other.
The database contains two imported canvases and import_count=1. One regression
fails; three controls pass (source deletion with retained immutable snapshot,
separate repeated-import copies, foreign source ownership denial).

The probe uses real service-role and authenticated PostgreSQL connections, actual
rate-limit SQL and the real create/import services. A barrier after the first
share read allows the other complete import to commit before the delayed one
continues. The counter is included in the API summary; no currently rendered UI
was found to depend on its total. This is inaccurate bookkeeping, not a loss of
an imported graph or an idempotency promise for repeated imports.

A service-only SECURITY INVOKER function now increments the current row and returns
the persisted count. The function has an empty search path and revokes execution
from PUBLIC, anon and authenticated. The caller uses that returned number instead
of computing a new value from its earlier read. On counter failure it retains the
observed count in the response rather than inventing an increment.

## Verification and limits

Eight actual SQL cases cover the reproduced two-copy race, twelve concurrent
counter increments on two connections, source deletion, repeated import copies,
foreign source denial, forged import owner blocked by RLS, authenticated RPC denial,
and a trigger-rejected counter write retaining the successful private copy.
Existing service/routes/adapter and migration-shape tests also pass. Clean migration
replay and full CI are required before release.

The counter remains best effort, separate from creation/history. Failed increments
can undercount; a lost response is not retried or certified exactly once. Historical
counts are not repaired. Repeat import intentionally creates another private copy.
Transport, actual Storage content and provider/assistant generation are not proved
by this database adapter. Fixtures are local-only and remove their users, rate-limit
rows, shares, canvases and injected trigger. The initial probe had a cleanup table
name typo; eight exact fixture IDs were independently verified and removed from
the isolated database, then the corrected probe produced one failure/three passes.
No production rows or balances were mutated.

Private evidence: `share-import-before.log` (includes the fixture cleanup error),
`share-import-before-final.log` (clean reproduction), `share-import-after.log`,
`share-import-final.log`, and the original probe source under
`.audit-evidence/backend-section-07/`.
