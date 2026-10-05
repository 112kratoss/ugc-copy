# Section 9I — summary error reporting release verification

PR #368 passed exact-head Quality 37344035869 on ece2c8a2553b80f5d1dffe5d2a2acf103c04c960
and merged at 17:05:15 UTC as d4c293a9f14b2f828e8636d03103b0faf6e5b700.
The mobile-store idle guard ran immediately before merge. Exact-main Quality
37345781975 and standard production release 37347329859 passed.

Independent verification at 17:47:34 UTC confirms the exact live build, public
feed 200, admin payout login redirect 307 and unsigned callback 401. Schema
fingerprints and all 109 security findings are unchanged from verified 9H.
There is no migration or customer repair. Actual local before-commit/lost-ack
PostgREST regressions and the normal CI unit regression establish the diagnostic
behavior; no production failure was injected. Private evidence is under
.audit-evidence/backend-social/summary-release/.

JOB-03 returns to untested after the known registration/summary defects are
released. The complete device, aggregation and notification lifecycle matrix is
still incomplete; local push simulators are not proof of device delivery.
