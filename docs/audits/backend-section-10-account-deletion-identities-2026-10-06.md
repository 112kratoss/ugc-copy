# Section 10B — linked identities, storage namespaces and durable claim history

Baseline 31a979fd (#373 candidate). Ten additional controls extend 10A's twelve
actual local Auth/Storage/PostgREST/SQL cases. No runtime or schema change.

- A real anonymous GoTrue identity is linked through the database's guarded
  profile transition. Deletion removes its files and Auth before the target,
  retains both IDs in the durable manifest and preserves an unrelated identity.
  A target Auth failure after guest deletion commits recovers on a later worker.
  This exercises linked deletion, not the complete account-merge request flow.
- Actual objects in all eight owner-prefix buckets are removed for the target
  while another owner's objects survive. Fixtures use valid generated PNG/WebP
  and WAV bytes, with MIME types admitted by each bucket, and Blob uploads.
- Nested template assets are removed by template prefix; the database snapshot
  remains with a null creator. Another creator's template and files survive.
- Public post media and private post files discovered directly in Storage are
  removed, including a nested private file. Another post's files remain. A
  historical owned post referencing another creator's generation does not grant
  deletion of that creator's global showcase namespace.
- A Storage enumeration outage prevents Auth deletion and recovers after a
  persisted failure. Welcome-credit fingerprint persistence failure likewise
  keeps Auth intact after the files were swept, then recovers.
- A real welcome-credit claim followed by an Auth email change and deletion
  preserves the changed identifier's digest. A new local account with that email
  cannot claim again and receives no additional credits. Only local synthetic
  credits are used; no payment or external identity provider is contacted.
- A separate live cleanup process pauses after a purchased-file copy commits.
  Another worker cannot reclaim before expiry, or after the fixture's 30-second
  lease expires while the unchanged two-minute route grace still applies. Both
  deadlines use real database time, with no timestamp edits. After both pass,
  a new worker completes initial cleanup. The old process resumes and observes
  resweep_pending without issuing an Auth deletion; one neutral retained copy
  remains and the buyer reads the original bytes both before and after resume.
  This covers that checkpoint, not every possible overlong worker boundary.

The normal production lease duration and resweep delay are unchanged. The 10A
future-resweep controls still accelerate their isolated fixture schedule; the
new live-worker control does not. Faults are injected at the HTTP transport,
with actual committed storage/database actions around them.

Trial fixtures initially used a disallowed image MIME in media-only buckets, an
overlong username and a malformed legacy PNG. Bucket/profile guards rejected
those fixtures and sharp rejected the PNG; valid fixtures replace them. The
initial live-worker expectation omitted the separate two-minute stale grace;
the database correctly withheld reclaim. None was a product defect.

Cleanup removes tracked accounts, objects, rows, jobs, upload blocks/tombstones
and rate keys. The privileged loopback fixture connection removes only the
random test identifiers' welcome-credit digests; production's append-only
service-role grants are preserved. No production account was deleted.

AUTH-03 remains untested for its complete scope. Real Apple revocation and
remaining purchased revision/generation-reference variants still need evidence;
this is also not a deployed proxy/browser deletion certificate. Full audit
completion is not implied by these bounded controls.

All 22 actual cases pass in the final 131.55-second run. Test typechecking and
scoped lint pass. Cleanup assertions pass, including the retained file mapping,
tracked template/post/generation rows and fixture-only claim digests. Private
logs are .audit-evidence/backend-social/account-deletion-final*.
