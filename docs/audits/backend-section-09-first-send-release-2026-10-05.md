# Section 9F — initial-send release verification

PR #361 passed exact-head Quality 37289045693 on `fd3aa2a2` and merged at
09:27:18 UTC October 5 as `32a3f47336a6ad54ff0c41b667d9ba41be8d12c2`.
The guarded merge checked mobile-store release idle immediately before merging.
Exact-main Quality 37290134172 and standard production release 37291187466 pass.
The backend watchdog run 37291679880 also passed.

Independent verification at 09:44:30 UTC matches that exact live build. The
updated finalizer, two new batch functions, invoker security, grants, reservation
column/default and existing recovery index match clean replay. Filtering only
the changed functions and added column reconstructs the filtered pre-release
schema fingerprint; object counts have exactly the planned additions. The
migration appears once by name `reserve_initial_mobile_push_deliveries` under
Management API ledger version `20261005093711` (source `20261005043056`).

Eight bounded rollback checks pass: durable reservation, foreign completion
rejection, saving outcome, preserving reservation on save, batch finalization,
refund of known unused budget, atomic token retirement and repeated completion.
Fixtures are absent after rollback. The existing 108 security advisor findings
are unchanged. Live smoke checks pass: exact build, public feed 200, admin payout
login redirect 307 and unsigned provider callback 401. No real push or customer
balance change occurred. Raw evidence is private under
`.audit-evidence/backend-social/first-send-release/`.

This verifies the initial-send persistence release, with the best-effort and
fallback-accounting limitations in its implementation report. JOB-03 stays open
for its remaining registration/preferences/device obligations and notification
summary persistence. JOB-02 also remains failed for the independently reproduced
maintenance starvation in 9G. The full audit is not complete.
