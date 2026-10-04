# Section 7K — concurrent template input finalization

October 4, 2026. Existing audit checkout, incorporating main 28b7467c. This finding
belongs to WORKFLOW-04 and overlaps MEDIA-08/09; no scope row is added.

Two signed uploads for the same run can both finalize from the same saved input
map. Previously each request copied its staged upload to a unique final object
and updated the run without checking that another finalizer had already replaced
that map. The second write overwrote the first reference; both final objects
remained although the run referenced only one. Different-slot requests could also
restore stale references for slots they did not submit.

## Reproduction and fix

A real local Storage/PostgREST probe held both HTTP PATCH requests until both
copies existed. On the original code the final-object assertion failed: two
objects remained for one slot. Five surrounding transport controls passed.
The raw before log is preserved as private `template-input-concurrent-before.log`.

`finalizeTemplateRunInputs` now conditions its existing owned, collecting-inputs
UPDATE on equality with the input JSON read at the start. PostgreSQL evaluates
that predicate atomically with the update. A losing finalizer gets a typed 409
`TEMPLATE_INPUT_CONFLICT`; its existing definitive-rejection cleanup aborts the
consumption claim and removes only its newly prepared copy. It can retry the
staging upload against freshly loaded state. An ambiguous commit acknowledgement
continues to preserve the possibly committed final object.

No migration, provider request, client contract shape change, or historical
object deletion is included. The object upload and database update remain separate;
this fix does not establish crash-proof atomicity across Storage and PostgreSQL.

## Evidence

Seven actual HTTP/Storage cases pass in `template-input-storage.test.ts`:

- Signed upload and finalization preserve exact image bytes, remove staging,
  deny anonymous/public reads, and reject consumed-token recreation.
- Matching-size non-image bytes fail image decoding without saving a path.
- Declared/uploaded size mismatch is rejected before acceptance.
- Replacement records the new final path and removes the previous final object.
- A real committed PostgREST PATCH with an injected 504 acknowledgement preserves
  final bytes; recovery from persisted state succeeds.
- Two simultaneous finalizations leave one referenced final copy, return one
  success and one conflict, and allow the losing staging upload to retry.
- A run queued between the read and commit retains its original final input;
  the rejected replacement is cleaned up.

Five permanent service regressions also cover same/different-slot interleavings,
run-start conflict, definitive rejection and lost acknowledgement. The template
unit suite passes 213 cases (53 environment-dependent/harness skips); the seven
Storage cases run separately and pass. The existing actual template-run SQL suite
also passes 25 cases (one child-harness skip). App/test TypeScript, targeted ESLint and
diff checks pass. Candidate CI/release remain pending.

Run the actual transport suite with a local Supabase stack, explicit local JSON
status file and local PostgreSQL URL:

```sh
SUPABASE_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:55322/postgres \
AUDIT_STORAGE_CONFIG=/private/path/local-status.json \
npx vitest run --config vitest.template-storage.config.ts
```

The suite refuses non-loopback endpoints and does not load `.env.local`. Its
separate Node config keeps native fetch, FormData and Blob aligned; the first
jsdom probe failed from mixed transport types, not a product defect. An initial
malformed-image expectation was split into distinct metadata-mismatch and image
validation cases after the real boundary rejected it earlier. Logs are preserved.
The seven transport tests are opt-in; normal CI runs the five service regressions,
not this Storage stack. Do not count skipped Storage cases as CI execution.

## Environment and remaining limits

The existing isolated database on 55322 was preserved and its API/Auth/Storage
services enabled at 55321 with Supabase CLI 2.75.0. The unrelated development stack
on 5432x was untouched. No database reset was performed. Private configuration,
local-only credentials, fixture IDs and raw evidence remain uncommitted under
`.audit-evidence/backend-storage/`.

Independent final readback over 44 fixture users found zero users, templates,
runs or Storage objects. There are 59 retained reservation rows (issued, finalized,
consuming, consumed or deleted), intentionally left under token/lease retention;
no trigger was disabled to erase them. Eventual reservation reclamation is not
certified. Hosted identity admission, owner/foreign JWT reads, token expiry,
worker death, ambiguous-outcome reclamation and historical orphan cleanup remain
open. WORKFLOW-04 stays failed until this candidate is released, and returns only
to untested afterward because the wider matrix is unfinished.
