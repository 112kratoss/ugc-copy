# Section 11V — background showcase revocation recovery

October 7, 2026. Four actual local SQL/Storage cases reproduce two defects in
`removeGenerationShowcaseDerivative`, shared by private publishing, post edits
and the background revocation worker. Normal cleanup omits the display path.
Storage deletion failure, a successful no-op deletion reply, or reply loss after
the gallery-row deletion commits destroys the retry inventory before the bytes
are removed. A later worker reports removal while gallery objects remain
readable. MEDIA-09 is failed until the fix is independently verified released.

The candidate includes the display variant, removes the full owned set, verifies
every path absent and only then deletes the legacy gallery rows. Storage or
verification failure retains the inventory. A lost final SQL reply is safe
because all objects were already verified absent. A failed final row cleanup
keeps the inventory for retry; a private legacy descriptor can temporarily point
to removed bytes until that cleanup succeeds. This favors completing revocation
and preserves durable retry paths. Canonical generation ownership checks,
pricing, schema and installed mobile contracts are unchanged.

All **10 actual SQL/Storage cases** pass after the fix:

- Normal cover plus source/preview/rendition/display/teaser removal.
- Storage rejection/no-op, verification failure, gallery cleanup rejection and
  reply loss after real gallery deletion; exact backoff and complete retry.
- Queue deletion rejection and reply loss after real queue deletion.
- A copy republished before the worker reads exposure is preserved.
- An invalid-prefix queue entry preserves its unrelated object and permits
  healthy work to progress.

The trigger queues the private transition in real SQL. GoTrue supplies the owner;
actual local Storage stores and serves inert PNG bytes. Only named transport
faults are controlled. Each case checks unchanged 500-credit balances, empty
usage and independent exact-ID cleanup of Auth/profile/generation/post/media/
queue/object rows. No worker death, concurrent republishing during deletion,
production CDN invalidation or actual video generation is claimed.

All **93 focused cases** across the helper, worker, publish and edit callers pass;
all **16 direct moderation Storage controls** still pass. App/test types, scoped
lint and diff checks pass. The publish test double initially lacked the newly
used SDK verification operation; it was completed and the full focused set
rerun. Before/failure/after logs are retained privately.

Initial exact-head Linux CI passed four jobs and nine of the ten actual cases.
The invalid-prefix case inserted a default database due time immediately before
using the application clock, so its second row could still be in the future.
The fixtures now explicitly set their own queue rows due one minute ago; no production
clock, queue or processor behavior is changed. A new candidate head must pass
the complete gates. The original failure is retained.

Bounded read-only production inventory reports zero queued/old-queued revocations
and zero currently known private generation legacy/display rows. The exposure
trigger's definition and execution grants match the local API database exactly.
These counts cannot reconstruct previously lost gallery paths; they do not
prove historical orphan absence. No customer object or reference is repaired
or deleted. Private evidence is in `.audit-evidence/backend-social/`.

Exact-head CI, verified parent, standard release and independent runtime-source/
schema/advisor readback remain required. Broader reference races, live-holder
fencing, historical orphan reconciliation and hosted delivery remain open under
MEDIA-09/JOB-01/02.
