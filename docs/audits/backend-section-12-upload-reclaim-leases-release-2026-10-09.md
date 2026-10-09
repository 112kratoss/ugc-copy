# Sections 12J/K — verified cleanup lease and recovery release

PR #422 merged as `b95045d844079717745be85058a6cfc314667d32` on October 9 at
04:05:19 UTC, including #421's worker-death controls. Candidate Quality
37880754176 and exact-main Quality 37882251025 passed all five jobs.

Standard production release 37882874131 first promoted that build successfully,
then failed its protected health build-ID check. The failure is preserved. Fresh
public readback and independent source/schema verification confirmed the intended
build. The unchanged failed job was retried; attempt 2 passed every gate,
including protected production health. The initial mismatch's root cause is not
established, and the failed first attempt is not counted as a passing release.

Independent readback after the successful retry at 2026-10-09T04:25:11.699Z confirms
that exact live build, tested runtime/migration hashes, and the two expected
function/service-role grant signatures from the clean replay. All other schema
and permissions remain unchanged; all 112 security findings are unchanged.
Migration `20261009030218_fence_media_upload_reclaim_consumption_leases.sql` is
recorded in production as `20261009041440` / `fence_media_upload_reclaim_consumption_leases`.
Do not edit this applied migration.

The production rollback fixture passed at 04:19:56 UTC on the same build and
schema: an active reader is withheld, completion allows cleanup to close reader
admission, a later reader is rejected, capacity remains charged, and the claim
neither deletes the object nor clears its intent. Rollback leaves zero users,
intents, reservations, objects, tombstones and counters. This fixture inserts
synthetic SQL metadata only; no actual customer Storage object was touched.
Public smoke and unsigned cron checks pass. Local credentials could not authorize
an independent protected-health call; that evidence comes from the successful
standard workflow, not from an inferred local result.

Local validation includes 21 actual cleanup cases, 2,360 SQL assertions, focused
checks, types and lint, plus the separate 961-second real-clock capacity test
recorded in the [12K report](backend-section-12-upload-reclaim-active-leases-2026-10-09.md).
That probe confirms the charge becomes zero after actual expiry/quiescence, with
empty duplicate work and exact fixture cleanup. The later 12M batch also repairs
a process-lifetime issue in the death-test harness; its unchanged SIGKILL assertion
passes in the final 28-case suite. That harness change is not yet deployed here.

MEDIA-09 returns to untested for its remaining reference, provider/Storage and
recovery matrix. The separate reproduced 12M job-reporting defects remain open
under JOB-02. Private evidence is `upload-reclaim-leases-release/` under
`.audit-evidence/backend-social/`.
