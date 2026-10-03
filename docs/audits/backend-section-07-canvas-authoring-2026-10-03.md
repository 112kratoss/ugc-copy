# Section 7H — canvas publication and restore revision consistency

October 3, 2026. Candidate follows 7G on main 9416008a. Local verification
passes; CI and deployment remain pending. WORKFLOW-04 remains failed until the
known authoring defects ship, then returns to untested for its remaining scope.

## Reproduction

Publication and history restore read the canvas revision and later wrote its
successor without requiring the stored revision to remain unchanged. Actual
route services under authenticated PostgreSQL connections reproduce four cases:

- A save commits between publication's read and write. Publication succeeds at
  the same revision as that save and publishes content it did not initially read.
- A save commits between restore's read and write. Restore succeeds, replacing
  the newer title and graph with the old snapshot at the save's revision.
- Two restores read the same revision. Both succeed and add history at the same
  revision instead of reporting the intervening change.
- Two saves commit while publication is delayed. Publication decreases revision
  6 to 5, compromising the version guard used by later saves and assistant apply.

The baseline produces four failing cases and one passing sequential control.
Soft assertions record persisted content/revision and history as well as the
incorrect successful responses. The injected boundary is after the real read
and before the real UPDATE; the competing service commits on a second authenticated
connection. This is deterministic interleaving at the SQL failure layer, not a
throughput/load claim.

## Change and validation

Both mutations now compare the stored revision with their initial read in the
UPDATE predicate. A missing returned row is a 409 conflict, so no stale mutation
or associated history snapshot is accepted. Ordinary SQL rejection remains 500;
missing/inaccessible initial records remain 404. Successful requests return the
persisted row and continue the existing snapshot behavior. No migration is needed.

Thirteen actual database cases pass: the four reproduced races, sequential
publication/restore, save losing to publication or restore, both foreign-identity
checks, both deletion races, and both real trigger-rejected writes. Ten existing
lifecycle service/route cases also pass. App and test typechecks and targeted
lint pass. CI includes a dedicated authenticated database step after clean
migration replay. Fixture rows and fault triggers are removed after each case.

The fixture adapts Supabase query chains to real PostgreSQL; it does not certify
PostgREST transport, browser behavior or real Storage. The normal-save race uses
an explicit baseRevision and a title edit with no uploads. Source search found
no current web/mobile caller of the two lifecycle action endpoints; the exported
routes still accept authorized calls and forward service error statuses.

History insertion remains deliberately best effort in the existing implementation
and tests. This change does not promise an atomic mutation-plus-history transaction,
exactly-once requests after a lost acknowledgement, or repair historical duplicate
revisions. Remaining sharing/import, assistant generation and upload-ownership
coverage stays open. Private before/after logs are in
`.audit-evidence/backend-section-07/canvas-authoring-*.log`.
