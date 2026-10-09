# Section 12K — staged cleanup versus consumption leases

Status: reproduced against actual isolated Auth, Storage, PostgREST and SQL;
local prevention passes. Production release remains pending.

An upload can be reused after its first generation. The generation input service
calls `finalizeUploadForConsumption` before downloading those bytes, acquiring a
durable reservation lease. The staged-upload cleanup service previously checked
legacy generation references but did not coordinate with that lease.

The reproduction creates and issues a real byte reservation, uploads and finalizes
an object, completes its first draft consumption, and creates an old consumed
intent. A second call to the actual finalization service acquires a new active
lease. Running the actual cleanup service then deleted the object and cleared the
intent while SQL still reported an active `consuming` reservation. A subsequent
Storage download returned Object not found. The initial teardown had an incorrect
tombstone column name; that log is retained separately. The corrected reproduction
fails at the download assertion and independently verifies zero fixture users,
reservations, intents and objects, with admission counters reconciled.

The new service-only `claim_media_upload_intents_for_reclaim(uuid[])` RPC checks
at most 500 exact old, uncleared intents. It shares the owner/path locks with
reservation admission and locks the matching reservation. Active or expired
consumers, uncertain outcomes, durable preservation and in-progress finalization
are withheld. An eligible finalized/consumed reservation moves to `deleted`
before external deletion, atomically preventing any new consumption lease. This
is a durable deletion request: the byte charge stays outstanding and the intent
stays uncleared until Storage confirms removal. The existing reservation worker
still requires its two-observation absence proof before releasing capacity.
Already claimed deletion can be retried after a failed request or dead process.
The existing accounting policy charges the original reserved maximum while a
reservation is `deleted` or `reclaiming`, rather than its smaller finalized byte
count. The tests verify this conservative charge explicitly. Available upload
capacity can therefore temporarily decrease until the reservation worker proves
absence and releases it; this change does not alter that accounting policy.
Taking deletion ownership clears an earlier scheduling deferral. A follow-up
actual regression with a one-day deferral failed in four deletion cases before
this correction. The original capability expiry and two-observation quiescence
gate still apply before release; a prior mobile-draft hold no longer delays them.

The application still applies the rollout gate, original 48-hour age and legacy
reference protection before requesting this claim. RPC failure aborts before
Storage deletion. Legacy uploads without v2 reservations retain their existing
compatibility behavior; this change does not claim to fence unleased legacy
readers or certify every concurrent reference-creation path.

Seven new actual integration cases cover:

- An active reader survives; cleanup succeeds after exact consumption completion.
- A reader arriving after the cleanup claim but before Storage deletion is rejected.
- A failed claim leaves the object fetchable and reservation consumable.
- A rejected Storage deletion remains retryable with capacity charged.
- A successful deletion with a lost acknowledgement is recovered from actual absence.
- An uncertain consumption outcome remains protected on repeated sweeps.
- An owned worker killed with SIGKILL after the durable claim leaves a charged,
  uncleared object; replacement cleanup and a duplicate complete safely.

All 21 actual reclaim cases pass, including the 12H/12I/12J controls. The 28 focused
service/migration tests, application and test typechecks, and scoped lint pass.
Type generation was refreshed after an inherited stale `.next` route declaration
referenced a route removed by #420; the initial diagnostic is retained. A clean
isolated migration replay passes all 2,360 pgTAP assertions across 111 files,
including actual anonymous/authenticated denial and service-role batch limits.

The new migration is
`20261009030218_fence_media_upload_reclaim_consumption_leases.sql` and is not yet
applied to production. Local test teardown bypasses only the reservation delete
guard inside a local transaction; the ordinary DELETE counter trigger remains
active, the guard is re-enabled before commit, and counters reconcile afterward.
No customer object or balance was used. Private evidence is under
`.audit-evidence/backend-social/upload-reclaim-active-lease-*` and
`upload-reclaim-leases-*`. MEDIA-09 is failed until verified release; its broader
recovery obligations remain open afterward.
