# Sections 11I/J — independently verified health and signup release

[PR #388](https://github.com/112kratoss/ugc-copy/pull/388) combines the separately
reproduced [health sampling](backend-section-11-health-sample-counts-2026-10-07.md)
and [signup collision](backend-section-11-auth-placeholder-collisions-2026-10-07.md)
fixes. Final head `bd5491c4de33ecb0cb8d6189073803f6df4cb448` passed all five
Quality jobs in `37529823695`, including 140 actual API cases. Verified parent
#386 and immediate mobile-store idle checks preceded its October 6 21:05:57 UTC
merge as `f227c69577503d35f04ddfc9dd000d932d10735e`. Exact-main Quality
`37531415452` passed all five jobs. #387 is closed as consolidated and has no
separate main release.

Standard production release `37532928397` attempt 1 promoted the expected build
but failed its final protected health check with “Production health build id does
not match the released commit.” The log does not establish the mismatching value
or its cause. Preserve that failure. The unchanged failed-job retry, attempt 2,
passed the full standard release, including protected production health, at
October 7 02:43:55 UTC. No manual deploy, source change or ledger repair was used.

Independent verification after the retry, at 02:47:11 UTC, confirms the exact
live build and `ugc-app` Supabase project. Only the planned `handle_new_user`
definition changes the public schema fingerprint; object count, every other
function and existing privileges are unchanged. Its digest is
`38b2a5ff84299035c88e229345f9cefa`, matching clean replay, with service-only
execution and the fixed definer search path. All 110 security findings are
unchanged. Source migration `20261006203443_auth_profile_username_collision.sql`
maps by separate readback to production version `20261006211856` with the same
name; no applied migration was renamed or edited.

Bounded production rollback controls create three isolated identities sharing a
placeholder prefix, including an anonymous identity. Generated names remain
unique and correctly formatted, the first owner remains unchanged, initial
balances remain zero, and both registered placeholders remain ineligible for a
welcome grant. The transaction rolls back; separate Auth/profile/grant readback
finds zero fixtures. No customer profile or balance was repaired.

Independent health verification at 02:47:26 UTC confirms the released source
matches the 48-case actual API candidate. It adds no further schema change. The
three sampled windows now disclose incompleteness using exact counts and reject
missing or inconsistent count metadata. Production's earlier read-only windows
were empty; no live undercount incident is attributed. Signed production health
was checked by the standard workflow; no separate local signed request is claimed.
Independent live build/feed/admin/unsigned-webhook checks return 200/200/307/401.

AUTH-01 returns to passed for its stated regression scope. All reproduced OPS-04
defects are now released and verified, so that broader obligation returns to
untested pending its remaining collector/method matrix. The 53-row ledger is
24 passed, 26 untested, 1 failed and 2 external; MEDIA-07 legacy retirement remains
failed. Private evidence is under `.audit-evidence/backend-social/` in
`auth-placeholder-release/` and `health-cap-release/`. Full audit completion is
not claimed.
