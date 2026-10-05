# Section 9J/K — alert dispatch and push-preference evidence release

PR #369 passed exact-head Quality 37345982967 on e849da13 and merged with the
mobile-store idle guard at 17:47:37 UTC as
1acdc6865887d0e863e4b0d9fd07c567cd14e549. Exact-main Quality 37351084486 and
standard production release 37352679153 passed.

Independent verification at 18:05:07 UTC confirms that exact live build, feed
200, admin payout login redirect 307 and unsigned provider callback 401. Schema
fingerprints and all 109 security-advisor findings match verified 9I. Private
evidence is in .audit-evidence/backend-social/dispatch-release/.

The batch adds eleven actual alert HTTP/DB controls and seven actual Auth/
PostgREST preference and retirement controls. It changes no runtime or schema.
The broader JOB-01/02/03 obligations remain open; this deployment is not evidence
of real device delivery or a configured external alert recipient.
