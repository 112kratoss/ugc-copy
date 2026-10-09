# Section 12M — verified cleanup job reporting release

PR #424 merged as `775f8b0e4a6f15c2d4e68323afd45ecfeac2965b` on October 9 at
09:49:40 UTC, including #423's private signed-read controls. Candidate Quality
37912714396 and exact-main Quality 37913764069 passed all five jobs.

Standard production release 37914826551 first promoted the build and then failed
the protected post-promotion health build-ID check. The failure is retained.
Fresh independent live source/schema/advisor checks and public smoke passed;
main still matched and no mobile store release was running. The unchanged failed
job was retried. Attempt 2 passed all gates, including protected production
health. The first attempt is not counted as successful, and its underlying
routing/build-ID mismatch is not claimed to be diagnosed.

Independent readback after the successful retry at 10:17:35 UTC confirms the
exact live build, both tested runtime-file hashes, unchanged schema and
permissions, and all 112 security findings unchanged. Public smoke passes:
app-version and feed return 200, the admin payout page redirects to login (307),
and an unsigned provider webhook returns 401. Protected health evidence comes
from the successful standard workflow. No migration or production data repair
was needed for this release.

The [12M fix](backend-section-12-upload-reclaim-job-reporting-2026-10-09.md)
propagates rejected eligibility/repair reads into failed durable job runs rather
than successful empty work. Seven actual managed cases verify failed runs,
lease release, retries and duplicates; the complete cleanup suite has 28 passing
actual cases. #423's private signed reads also verify ownership, token/path
integrity, real expiry/deletion and byte ranges with fixture cleanup.

JOB-02 returns to untested for the remaining per-job budget, poison-work and
recovery matrix. The separate 12P profile request-limit finding remains pending.
Private verification evidence is `upload-reclaim-managed-release/` under
`.audit-evidence/backend-social/`.
