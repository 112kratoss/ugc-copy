# Section 7B — publication assets after a lost activation reply

Date: October 3, 2026. Candidate baseline: 7c304082 (Section 7A). This is a
scoped correctness fix, deployed and independently smoke-checked. Actual Storage
transport verification remains pending. See the companion publication release report. WORKFLOW-04 and MEDIA-08/09 remain open.

## Failure and change

Publication copies demo/fixed assets under a fresh version ID, then calls
`activate_template_version`. The RPC can commit the immutable version and its
asset references, but lose its response. The service previously removed the
copied assets on every returned RPC error or malformed response. The version
therefore pointed to objects that the failed request had just removed.

The service now removes candidate assets only after a received definitive 4xx
mutation rejection, using the existing mutation-outcome classifier. A thrown
request, 5xx, missing status, malformed response or missing boolean `inserted`
field preserves the objects and still reports the activation error. Normal
acknowledged insertion and acknowledged reuse retain their existing behavior.
This does not turn uncertainty into a successful publication response.

## Evidence and limits

- The permanent service test failed before: activation was recorded but its
  referenced object was missing. Five cases now cover lost reply, thrown request,
  malformed response, missing insertion flag and definitive rejection cleanup.
- A disposable database on the audit container's port 55322 was populated with
  the existing schema. The real activation function ran as service_role in
  autocommit mode. A second connection read the committed immutable version
  before the injected lost reply. The original service then removed its referenced
  object; the candidate preserved it. A final candidate rerun passed.
- Storage upload/download/remove used controlled in-memory fixtures. No actual
  Supabase Storage reachability, real provider delivery or production publication
  is certified by this probe. SQL ownership/constraints and the commit/readback
  boundary were real; source template/canvas/run service reads were fixtures.
- The disposable schema restore encountered four grants for an unavailable
  GraphQL extension wrapper. Those unrelated grants are recorded, not called a
  clean full migration replay. The production activation function and tables,
  their original ownership, and service-role execution were exercised. The
  separate database was deleted after readback; the existing audit DB was kept.
- App/test types and targeted lint pass. Fifteen focused cases pass. Full-suite
  result and later CI/release results are recorded in the handoff.

Unknown outcomes can retain unreferenced candidate assets. They need a separate
reference-aware reconciliation policy; deleting them speculatively would recreate
this failure. This patch does not certify orphan cleanup or all publication races.
Private before/after logs, the executable SQL-backed probe source and baseline
module are under `.audit-evidence/backend-section-07/`.
