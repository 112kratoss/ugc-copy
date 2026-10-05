# Section 9H — atomic registration release verification

PR #364 passed exact-head Quality 37319529666 on 07d43d14 and merged October 5
at 16:50:34 UTC as 8ff10cc6480d2cea341a2157db21ba5d25b86f5d. Mobile-store
release was checked idle immediately before merge. Exact-main Quality
37343916362 and standard production release 37344929966 passed. Independent
mobile changes #363/#360/#366/#365 are preserved; they add no backend schema delta.

Independent verification at 17:03:17 UTC confirms the exact live SHA. The function
definition, invoker security, search path and ACL match clean replay. The filtered
schema matches the pre-release baseline; exactly one function and one routine
grant were added. Source migration 20261005100245 maps once by name
serialize_mobile_push_registration to production ledger version 20261005165911.

Eight rollback controls pass: first preference initialization, stable row ID,
paused preference retained, same-device rotation, prior token retirement,
exclusive account handoff, independent-device preservation and denied untrusted
RPC access. Separate cleanup confirms zero fixture users, tokens and preferences.
All 109 baseline security advisor findings are unchanged. Live build/feed 200,
admin payout login redirect 307 and unsigned callback 401 pass. Raw evidence is
private under .audit-evidence/backend-social/registration-release/.

No real push, customer balance mutation or historical token backfill occurred.
This verifies the atomic API registration protocol, with the direct-table and
mixed-version limitations in the implementation report. It does not certify
physical device delivery or every sign-out race. JOB-03 remains open pending the
summary observability release and the broader notification matrix.
