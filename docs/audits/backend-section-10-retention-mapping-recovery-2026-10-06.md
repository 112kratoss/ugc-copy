# Section 10H — verify committed retention objects before erasure retry

An actual local failure reproduced deletion trusting a committed revision/file
mapping after its retained Storage object was removed. On the deletion retry,
Auth and the original owner Storage files were erased, but no neutral retained
object survived for the buyer. The saved mapping was treated as proof of a copy
without checking Storage. This is a reproduced fixture failure, not an attributed
production incident.

Four actual Auth/Storage/PostgREST/SQL regressions fail against the unchanged
retention implementation:

- A missing committed retained object is not recreated from the surviving source.
- With both source and retained object missing, deletion proceeds rather than
  retaining Auth and a failed job for recovery.
- A retained-object metadata outage is skipped because the mapping already exists.
- An invalid retained mapping is accepted before irreversible source/Auth erasure.

The candidate reads the complete mapping and requires the existing neutral bucket
and deterministic retained path. Before skipping a copy, it asks actual Storage
for the mapped object. An actual not-found result re-copies the available owner
source and records the mapping. Other errors halt deletion. Missing source data
halts deletion with a failed/retryable job; the audit does not bypass blocked
owner uploads to manufacture recovery. Metadata outage and corrected-mapping
controls recover, delete Auth and preserve readable matching buyer bytes.

The local Storage SDK returns HTTP status 400 with `statusCode = '404'` for a
missing object; the implementation classifies `statusCode` first. The first
candidate correctly halted erasure but could not repair that 404 until this
actual response was inspected and handled. No applied migration, grant,
dependency version or signed-URL TTL changes.

All four targeted regressions pass after the candidate; 36 focused service
checks, app/test types and scoped lint pass. All 53 actual local deletion/access cases pass on Node 24.21.0 (163.35
seconds), including the four regressions and all prior 49 cases. Tracked
Storage/Auth/SQL/job fixture cleanup passes. The 10G signed-webhook evidence is included in this
candidate; it adds twelve real local HMAC/dispatcher/SQL lifecycle controls.

This verifies an object gate on retry while source data still exists. It does
not restore data that was already erased, prove immutable Storage bytes, or
claim an atomic transaction spanning Storage and Auth. Production release and
independent unchanged-schema/advisor/live verification remain. MEDIA-09 is failed
until this defect is released/verified; broader retention/input/output recovery
stays open afterward. PAY-04 remains failed until the independently scoped 10F
release verification completes. No customer data repair or provider call was
performed. Private logs are under .audit-evidence/backend-social/retention-mapping*.
