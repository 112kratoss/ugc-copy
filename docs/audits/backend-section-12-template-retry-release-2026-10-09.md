# Sections 12S/T/U — retry recovery release verified

PR #431 passed all five candidate Quality jobs (37959157884) and merged as
`6b39c0b7aadecfeefc2c137ec3809801c214abba`. All five exact-main Quality jobs
(37961087969) and standard production release 37962589617 succeeded.

Independent readback at 17:03:58 UTC verifies that exact live build, the tested
template runtime source, unchanged schema/permissions and all 112 security
findings unchanged. Public smoke passes: app-version/feed 200, admin payout
login redirect 307, unsigned provider webhook 401. No migration or customer
repair was needed; a bounded production inventory found zero runs matching the
stuck generation retry condition before release.

The [12U retry fix](backend-section-12-template-retry-resume-2026-10-09.md)
reports a failed run-resume write and lets a repeated request resume the
existing queued attempt without another attempt or charge. Its 45 database
and 58 focused controls pass. The release also includes
[12T pre-submission worker death controls](backend-section-12-template-presubmit-recovery-2026-10-09.md)
and [12S profile media rate/admission controls](backend-section-12-profile-media-limits-2026-10-09.md).

WORKFLOW-02 remains failed for the separately reproduced 12V checkpoint approval
atomicity defect, whose candidate is PR #433. Broader workflow and profile
coverage remain open. Main has advanced through UI wording PR #432; this
verification concerns the live `6b39c0b7` build at the stated time, and does not
claim that the newer main build has been independently verified yet.

Private baseline, comparison and smoke evidence are retained in
`.audit-evidence/backend-social/template-retry-resume-release/`.
