# Sections 9M/9N — feed recovery and provider-history release verification

PR [#372](https://github.com/112kratoss/ugc-copy/pull/372) passed exact-head Quality
37362149076 on 93d7b0a39d7fc53dbcb0f71aa587c618dc8f991e and merged October 6
at 16:18:24 UTC with mobile-store release idle as
9cbe5815aa94179e90b1c249cd932a4f369b38b4. Exact-main Quality 37494657028 and
standard production release 37495795918 passed.

Independent verification at 2026-10-06T16:31:02.928Z confirms the exact live build,
the clean-replay function digest, invoker configuration and service-only ACL.
The only schema changes are the planned function and its routine grant. All
seven bounded rollback controls pass, draft fixture releases/entries/checks are
zero after rollback, and all 110 security advisor findings are unchanged. Feed
returns 200, the admin payout page redirects to login with 307, and an unsigned
generation webhook returns 401. Private evidence is in
.audit-evidence/backend-social/model-verification-release/.

Source migration 20261005190934 is recorded in production as 20261006162734,
name read_latest_provider_check_per_model.

The lookup selects the latest observation for each model independently and
breaks equal timestamps by descending check identity. Sparse history no longer
loses a model's previous discrepancy streak. Production rollback probes use a
draft fixture catalog and never activate it or contact a generation provider.
This closes the named history defect; JOB-02 remains untested for its broader
budget, progress and retention matrix.

PR [#371](https://github.com/112kratoss/ugc-copy/pull/371), the 17 feed-maintenance
recovery controls, is an ancestor of this independently verified live build.
Its exact-main Quality 37361374584 passed on c0f33e438800de69b6e99736ac2904141d0a93e1.
Release 37362937477 failed before any deployment action: GitHub's hosted runner
never acquired the deployment job, which has no steps and was cancelled. The
annotation and job details are preserved privately. This verifies 9M's lineage
on the released descendant, not deployment of its original exact main SHA.
The 9M batch changes tests and evidence only; local phase failure, process death
and managed retry controls remain bounded by their report.
