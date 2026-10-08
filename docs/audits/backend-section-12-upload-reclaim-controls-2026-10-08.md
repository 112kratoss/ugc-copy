# Section 12H — staged upload cleanup recovery controls

Nine controls pass against the actual reclaim service, local PostgREST, Storage
and SQL. Test typechecking and scoped lint pass. CI is pending. This batch adds
regression evidence; it changes no application behavior or database schema.

Each fixture owns one user, one 72-hour-old consumed upload intent and one small
Storage object. Network calls are restricted to the isolated local Supabase API.
The tests inject transport failures at the Storage DELETE or the subsequent
intent PATCH, while all ordinary listing, deletion and bookkeeping use real APIs.

| Control | Observed state and recovery |
| --- | --- |
| Normal cleanup | Object is removed and intent marked cleared; later sweep scans nothing. |
| Rejected deletion | Object and uncleared intent survive; next sweep removes and clears both. |
| Lost deletion acknowledgement | Real deletion commits, then response is replaced with an error; intent stays open, and the next listing proves absence before clearing it. |
| Failed bookkeeping | Object is gone but the failed PATCH leaves the intent open; retry proves absence and clears it. |
| Protected path | Object and intent remain untouched while the supplied protection set contains the path; removal proceeds only after protection is withdrawn. |
| Unavailable protection data | A null protection set retains the object and intent; a later proven empty set permits cleanup. |
| Legacy stored path | The real legacy-generation selector and path extractor protect the referenced upload; removing the generation reference allows cleanup. |
| Legacy signed URL | A signed Storage URL in the real generation settings resolves to the protected object, despite its query string. |
| Protection lookup error | A failed RPC response makes actual protection discovery fail closed; a successful later scan permits cleanup. |

Every case checks SQL state after its first pass, recovery and an empty follow-up.
Cleanup uses Storage removal before deleting the exact fixture user; independent
SQL checks require zero users, upload intents and Storage objects. No real uploads,
provider calls or production data are involved.

The first six cases supply the protection set through the real service option;
the final three exercise actual SQL reference discovery and its failure path.
These cases do not certify every reference variant, the scan cap, or concurrent
reference creation. Nor do they certify signed-upload expiry, installed-client
rollout, large backlogs, managed-job fencing, or worker death. Those obligations
remain MEDIA-08/09 and JOB-02. A successful Storage deletion is counted in
`reclaimed` even when the bookkeeping write fails; the intent remains retryable.

Private evidence and the initial instrumented fixture are under
`.audit-evidence/backend-social/upload-reclaim-*`. The committed suite is
`src/__tests__/media-upload-reclaim-postgrest.test.ts`, invoked in the existing
isolated API integration CI job.
