# Section 12V/X — verified atomic approval release

PR [#433](https://github.com/112kratoss/ugc-copy/pull/433) merged at 05:31:03 UTC
on October 10 as `ec0e08dbf0df48ee5dd9b07ba50192a63baf2c70`. All five candidate
jobs in Quality 38027148902, all five exact-main jobs in Quality 38027773322,
and standard production release 38028486183 succeeded. The pre-merge guard
verified the parent release, live build, unchanged schema/advisors and idle
mobile store release state. Duplicate release 38028538476 skipped.

Independent readback at 07:11:40 UTC confirms the exact live build, tested runtime
and migration sources, unchanged existing schema and permissions, and the new
approval function and service-only grant matching clean local replay. All 112
security advisor findings are unchanged. Source migration
`20261009163235_atomic_template_checkpoint_approval.sql` appears once by name
under production ledger version `20261010054423`; do not edit the applied file.

The bounded service-role rollback probe passed at 07:12:00 UTC: foreign-owner
rejection, atomic approval and queued execution, duplicate refusal, terminal-run
refusal and no generation creation. Independent cleanup found zero fixture
users, profiles, templates, runs, steps, jobs and generations. Public checks
returned app-version/feed 200, admin login redirect 307 and unsigned callback
401. Private evidence is `template-approval-release/` under
`.audit-evidence/backend-social/`.

The [12V fix](backend-section-12-template-approval-atomicity-2026-10-09.md)
resolves false approval success and a committed checkpoint after a failed resume
write. Evidence includes 49 actual database controls, 265 template tests and
2,376 clean-replay SQL assertions. [12X scheduler controls](backend-section-12-workflow-job-admission-2026-10-10.md)
are also included; all nine actual PostgREST/SQL cases pass candidate/main CI.
No real customer repair or provider request was performed.

This closes the reproduced approval defect. WORKFLOW-02 returns to untested for
the broader execution, transport and recovery matrix; it is not whole-workflow
or complete-audit sign-off.
