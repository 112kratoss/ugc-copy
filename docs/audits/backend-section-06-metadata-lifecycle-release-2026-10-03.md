# Section 6S — interrupted metadata initialization release

Recorded October 3, 2026 (Asia/Kolkata). PR [#288](https://github.com/112kratoss/ugc-copy/pull/288)
merged October 2 at 19:35:01 UTC (October 3, 01:05:01 IST) as
`dd3d6c13e25b2963e9d190a88c8df1354fcdb88c`.

Interrupted initialization now has a separate unpublished namespace. Under the
shared admission lock, the sweeper removes only recognized private metadata
with no live lease or payload. Completed initialization atomically moves to the
existing published namespace so older capacity-aware workers count its claim.
Unknown payloads and legacy scratch remain preserved.

- PR Quality `37052965820` passed all four jobs first attempt: 6,648 web tests,
  2,911 mobile, 21 browser, 1,941 SQL assertions, 130 database cases (one harness
  skip), real FFmpeg/admission checks and 163 native route traces.
- No mobile store release was active before merge.
- Exact-main Quality `37055063444` passed all four jobs.
- Standard production release `37056337938` passed first attempt, including
  staged and protected live health, at October 2 19:50:18 UTC / October 3
  01:20:18 IST.
- Independent public live verification matched the exact merge SHA; feed returned
  200, unauthenticated admin redirected to login (307), and unsigned generation
  webhook returned 401. No paid generation or customer mutation was performed.

The [local report](backend-section-06-metadata-lifecycle-2026-10-03.md) retains
before/after inode-pressure, actual owner-kill, inherited-reader and old/new
admission compatibility evidence. Private logs are in
`.audit-evidence/backend-section-06s/`.

MEDIA-07 remains open for verified legacy environment retirement. This release
does not certify deletion of old scratch or production filesystem capacity.
Ledger remains 22 passed, 27 untested, one failed, three external.
