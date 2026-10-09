# Section 12O — profile-media ownership and cleanup controls

Eight actual Storage/PostgREST/SQL cases pass on the isolated local stack. No
application or schema change was needed for these cases. They add evidence to
SOCIAL-04 and MEDIA-08/09; they do not close those broader obligations.

Avatar and cover signing bind the object and durable byte reservation to the
caller despite injected owner/path fields. The anonymous client can upload exact
fixture bytes with the issued capability, but cannot rebind it to another owner
or overwrite the existing object. Cross-owner finalization returns 404; the owner
can finalize and repeat finalization with the same descriptor. After cleanup,
the original capability cannot recreate the explicitly finalized object. Its
reservation remains charged until the ordinary reclaim lifecycle resolves it.

An additional actual profile save/edit case uses a 1024-pixel image large enough
to attempt normalization. The existing Storage write guard preserves the exact
finalized bytes and object version; normalization is best-effort. The profile
persists successfully and a later display-name edit with the same image succeeds.
This establishes identity safety, not successful resizing of reserved uploads.

Other cases verify:

- Invalid roots, roles, blocked file types and oversized declarations reject
  without creating a reservation.
- Mixed-owner batches, traversal and encoded separators, invalid elements and
  batches above four paths reject before any Storage removal. Both owners'
  objects remain intact.
- A rejected Storage deletion returns failure and retains the object. A lost
  acknowledgment after a real successful deletion also returns failure. Both
  retry successfully, and duplicate cleanup succeeds when the object is absent.
- The unrelated owner's object survives every case. Exact teardown verifies no
  fixture users, reservations, objects or rate-limit rows remain, and global
  upload admission counters reconcile.

The initial run failed before fixture creation because Docker/database were
stopped. The existing volumes were restarted without a reset. The initial seven
cases then passed. Expanded finalization checks disproved a fixture assumption:
explicit finalization closes Storage admission, so replay after deletion is
denied. The corrected assertion checks that denial; all seven cases pass again.
The publication case brings the final suite to eight passing cases. These
diagnostic logs are retained and are not product-defect evidence.

The permanent suite is `src/__tests__/profile-media-postgrest.test.ts`, selected
by `vitest.profile-media-postgrest.config.ts` and added to API integration CI.
Both database and API addresses must be loopback; the test client's fetch rejects
external origins. No capability tokens are written to the report or evidence.
Private logs use `profile-media-*` under `.audit-evidence/backend-social/`.

This covers signing, explicit finalization and cleanup services with real
dependencies. Broader profile publication/normalization, request byte limits, route
identity variants, rate-limit exhaustion, hosted caching and further lifecycle
cases remain open. Test typing and scoped lint pass. CI and production inclusion of this test batch
are pending.
