# Section 9G — maintenance progress release verification

PR #362 passed exact-head Quality 37293789959 on
34fc96ee67fd8e3c96e49a02b0e98966ff56df0b and merged October 5 at
13:33:49 UTC as 36962d613c5a70d3dc125319e25a37f63633e75b. The guarded
merge checked mobile-store release idle immediately before merging. Exact-main
Quality 37317775601 and standard production release 37319362945 passed.

Independent verification at 13:50:17 UTC matches that exact live build. The scan
function definition, invoker security, grants, state-table RLS, columns,
constraints and four indexes match the replayed local schema. Filtering only
planned additions reconstructs the pre-release schema fingerprint, and all
object-count deltas match. Source migration 20261005092947 appears exactly once
by name advance_mobile_push_maintenance_scans under production ledger version
20261005134644.

Six bounded production rollback controls pass: first fixture page, persisted
position, second page despite unchanged first work, retained outcomes, fixed
endpoint and denied untrusted-role execution. The probe pins both scan bounds
to rollback fixtures and never wraps into live work. Separate cleanup confirms
zero fixture users/deliveries. The original 108 security advisor findings are
unchanged; one expected INFO rls_enabled_no_policy describes the new service-only
scan table. No warning or error was added.

Independent live smoke passes: exact build, public feed 200, admin payout login
redirect 307 and unsigned callback 401. Private evidence is under
.audit-evidence/backend-social/push-progress-release/. No real push or customer
balance mutation occurred. JOB-02 returns to untested because its broader
budget/retention/alert matrix is incomplete; this scoped defect is released and
verified. JOB-03 remains failed for the registration candidate and summary
observability finding. The full backend audit remains open.
