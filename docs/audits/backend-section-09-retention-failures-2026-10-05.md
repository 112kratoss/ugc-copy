# Section 9B — supplementary retention failure reporting

The operational retention wrapper silently discarded errors returned by five
supplementary prune RPCs, reporting zero deleted rows without a failure marker or
log. If a call rejected instead, it stopped later work despite the documented
best-effort behavior. Eleven service-layer regressions failed before the fix.

The wrapper now records failed operation names in `supplementaryPruneFailures`
and emits one structured error for each failure. It continues the remaining
supplementary work while preserving successful main-sweep counts. A subsequent
successful run has an empty failure list. Main-sweep errors still propagate.
Object reclamation remains outside this best-effort catch: its failure still
stops the later upload-reservation bookkeeping prune.

Thirty-nine focused tests pass, including the eleven regressions and the added
object-reclamation stop control. App/test typechecks and scoped lint pass.
An opt-in actual PostgREST test calls the real managed retention job twice:
maintenance RPC responses and Storage reclamation are injected, while actual
job-run inserts/updates and lease RPCs use the isolated database. An injected
503 appears in the durable first summary; the successful retry gets a separate
clean summary. Both leases release and the two fixture job records are removed
with independent absence checks. No unrelated audit data is pruned by that test.

Permanent tests are `operational-retention-failures.test.ts` and
`operational-retention-postgrest.test.ts`; the latter uses its matching opt-in
Vitest configuration. Private baseline/after logs are under
`.audit-evidence/backend-social/retention-*`.

No migration or mobile runtime/contract change. The route remains best-effort
success when only a supplementary operation fails; the new summary field is
operator-facing, additive, and saved in the existing JSON job-run field. This
does not claim an alert is automatically delivered or that every retention SQL
policy and job interruption is verified. JOB-02 remains failed until this scoped
fix is released, then returns to untested for the larger bounded-progress matrix.
