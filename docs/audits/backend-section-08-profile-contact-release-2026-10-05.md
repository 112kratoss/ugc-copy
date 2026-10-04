# Section 8E — profile payload release

PR #341 passed all four Quality jobs in 37215420224, then merged as
`61620d00f5461f6fa86e19a7336b690bd20fe480` at October 4 19:28:26 UTC.
No mobile store release was active immediately before merge. Exact-main Quality
37228400582 passed; standard release 37229182326 succeeded at 19:44:03 UTC.

Independent live verification on resumption found descendant
`644a0e3dd45af3915db057aa2332b5596d7da6af`, released by 37230192044 after
Quality 37229440421. The two profile adapters are unchanged in that descendant.
Exact live SHA, feed 200, admin auth redirect 307 and unsigned webhook 401 pass.
The initial exact-old-SHA probe correctly rejected the newer build; it was not
a failed deployment. Private evidence: `.audit-evidence/backend-social/profile-release/`.

Malformed/non-object profile requests now return 400; the finding and before/after
HTTP, PostgREST and client contract evidence are in the profile/contact report.
No migration, customer repair or mobile runtime deployment was needed. SOCIAL-04
returns to untested for the remaining profile/creator/contact matrix.
