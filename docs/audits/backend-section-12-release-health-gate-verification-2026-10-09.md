# Section 12R — protected release health identity verified

PR #429 passed all five candidate Quality jobs (37957625786) and merged as
`0ad91678fa7030dfcc1ad5f54d015cd0eb1c5bd0`. All five exact-main Quality jobs
(37958955983) passed. Standard production release 37960469877 succeeded,
including the modified staged and post-promotion health checks.

Independent verification at 16:42:18 UTC confirms the exact live build, the two
tested release files, unchanged schema/permissions and all 112 security findings
unchanged. The standard workflow log explicitly records that the new protected
production verifier accepted the exact SHA after one request. This proves the
new gate actually executed; bounded stale-build retry behavior is covered by
the twenty-two local verifier controls, not inferred from this one-request run.

Public smoke passes: app-version/feed 200, admin payout login redirect 307 and
unsigned provider webhook 401. No migration, credential change, customer repair
or production fixture was needed.

The [12R identity finding](backend-section-12-release-health-gate-2026-10-09.md)
is resolved. OPS-04 returns to untested for its remaining broader obligations.
The cause of earlier old-build responses after promotion remains unestablished;
this release does not claim to diagnose that serving behavior. Private baseline,
source comparison, sanitized gate marker and smoke evidence are retained under
`backend-social/production-health-gate-release/` in `.audit-evidence/`.
