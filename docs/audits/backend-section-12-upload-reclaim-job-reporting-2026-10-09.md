# Section 12M — truthful upload cleanup job failures

Two actual managed-job failures were reproduced against isolated PostgREST and
SQL. When there were no old consumed intents, a rejected legacy eligibility RPC
was caught and converted into `false`; the job returned success/skipped and
persisted `no_reclaimable_media_uploads` with no error. When an old consumed
intent existed, a failed repair selection returned an empty successful repair
summary, and the job persisted succeeded despite being unable to examine the
repair backlog. Its later protection lookup safely retained the object; this
second defect concerns durable failure reporting, not unsafe deletion.

The eligibility and repair-selection catches now log and propagate the original
error. The existing managed wrapper records a failed run, releases any acquired
lease, and returns failure. A subsequent successful invocation can retry. No
query limits, protection policy, age gate, schema or provider behavior changes.
Actual callers are limited to this managed job; the prior unit expectations for
silently successful errors were corrected to match the observed failure contract.

Seven real PostgREST/Storage/SQL cases cover empty work; failed eligibility;
failed intent selection; failed repair selection after work is found; failed
reclaim claim; an existing live foreign lease; and normal cleanup. Every case
checks the returned status against durable run history, then exercises retry and
a duplicate. The failure/locked cases preserve the object until the successful
retry. The live foreign lease survives the contender; owned leases are released.
Each fixture verifies zero users, intents, objects, run rows and job locks.

The seven new cases and 27 focused tests pass, as do application/test typing and
scoped lint. The first complete integration run also exposed the repair-selection
failure and encountered a 30-second timeout in the existing 501-object progress
case under concurrent host activity. That log remains retained; it is not counted
as a passing run. The next full run passed the progress test but exposed a process-death harness
race: a pending Promise did not keep the child alive after its HTTP sockets went
idle, so the child could exit normally before SIGKILL. The fixture now retains an
interval while paused, ensuring the parent actually kills a live process. The
SIGKILL assertion remains unchanged. The final complete run passes all 28
actual cleanup tests across five files in 27 seconds; all fixtures clean up.

Private before/after evidence uses `upload-reclaim-managed-*` under
`.audit-evidence/backend-social/`. [Production release is independently verified](backend-section-12-upload-reclaim-job-reporting-release-2026-10-09.md). JOB-02 returns to untested; this batch does not close the
remaining per-job recovery, poison-work or expiry-fencing matrix.
