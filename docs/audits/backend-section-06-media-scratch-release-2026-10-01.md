# Section 6N release — media scratch leases

Status: deployed and verified. Release completed October 1; independently
rechecked against newer production on October 2, 2026.

- PR: https://github.com/112kratoss/ugc-copy/pull/257
- Runtime commit: `82ec7ecbfaf844cae0ca1893872bf90eeff4854a`.
- PR head: `e2f5b6b2` (isolates child TSX cache in the real-process probe).
- First Quality: `36872492921`; 6,178 web tests and the existing real FFmpeg
  source-lease probe passed, mobile/browser/database jobs passed. New scratch
  probe reclaimed media but failed its empty-directory check on TSX cache files.
  Original failure retained; no runtime change to address this harness issue.
- Final PR Quality: `36873464662`, all four jobs passed. Real FFmpeg crash and
  cancellation checks and 163 native artifact traces passed.
- Merge: `149b9edc39c4ab895f049b270e86bdff960b1b95`, 2026-10-01
  14:17:15 UTC (19:47:15 IST). No mobile store release active before merge.
- Exact-main Quality: `36875154079`, all four jobs passed on the first run.
- Standard production release: `36876633477`, successful first attempt, October 1
  14:31:58 UTC (20:01:58 IST). Staged and protected production health passed.
- On October 2 the live build is newer main `626f398ca01d179113663868d76d658e332184e1`,
  containing #257 and 15 later PRs. Those changes leave the staging, poster,
  rendition and crash-probe implementations unchanged. Current release
  `36975169861` succeeded October 2 at 06:49:45 UTC (12:19:45 IST).
- Independent live checks on resumption: exact current build, feed HTTP 200,
  admin payout login redirect 307, unsigned Kie webhook 401. This is a fresh
  check on the newer build, not a claim that an independent probe ran when #257
  first deployed. No stale release was triggered.

Local verification: 81 focused tests, 6,176 full web tests before adding the two
caller assertions, app/script/test typechecks and targeted lint passed. Linux
Node 24.21.0 with actual FFmpeg 8.1.2 verifies three parent deaths with inherited
source/output ownership and fresh-process reclamation, real cancellation after
the writer opens, and successful/invalid-input cleanup. Existing macOS Node 22 /
FFmpeg 6.0 FIFO source-lease test passes. Linux probe uses a 128 MiB tmpfs and no
network. Its dedicated containers/image were removed after recording hashes.

No migration, dependency or mobile runtime change. New scratch uses existing
staging authority; legacy/unpublished scratch and shared capacity admission
remain open. MEDIA-07 remains failed/open for the broader policy. Scoped ledger:
53 obligations, 21 passed, 27 untested, 2 failed, 3 external.

Source report: `backend-section-06-media-scratch-2026-10-01.md`.
Private logs: `.audit-evidence/backend-section-06n/`.
