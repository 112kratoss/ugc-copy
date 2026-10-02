# Section 6R — shared staging admission release

Recorded October 3, 2026 (Asia/Kolkata). PR [#281](https://github.com/112kratoss/ugc-copy/pull/281)
merged October 2 at 17:11:21 UTC as `20862a0b0780b859de0175565f65059050f2bd8c`.
The runtime commit is `12687d78`; `51aee09e` adds recovery-suite isolation and evidence.

Concurrent cooperating writers now reserve enforced growth before allocating
scratch. Sources release future growth after their pipeline closes; actual
retained bytes remain charged through filesystem occupancy. Inherited child
leases retain claims after parent death. Block and inode headroom reject excess
work before allocation. Capacity refusal preserves repair retry allowance, and
workers run the final attempt already reserved by the database.

## Gates and production evidence

- First PR Quality `37037025984` exposed two shared-queue test collisions. The
  same four-file command reproduced both locally; another suite's audit-crash
  generation appeared in the output-recovery suite's injected failure log.
  Sequential file scheduling fixes fixture isolation, retaining explicit
  concurrency and kill probes. The superseded web job was cancelled by the
  update after its 6,583 tests and real FFmpeg/admission checks had passed.
- Updated PR Quality `37037902850` passed all four jobs: 6,583 web tests (127
  skipped), 2,911 mobile tests, 21 browser tests, 1,941 SQL assertions in 90 files,
  128 database integration cases (one child-harness skip), real FFmpeg/admission
  probes and 163 native route traces. No mobile store release was active at merge.
- Exact-main Quality `37039015096` passed all four jobs for merge `20862a0b`.
- Standard production release `37040248048` succeeded first attempt October 2 at
  17:25:53 UTC (22:55:53 IST), including staged and protected live health.
- On resumption, production was `1361e2c4`, containing 6R plus the subsequent
  completion-job fix. Independent live SHA/feed 200/admin redirect 307/unsigned
  webhook 401 checks passed. Checkout now also incorporates `24194f1d` and its
  canvas request-key fix without conflict.

The later `24194f1d` release `37051401271` failed its post-promotion protected
build-ID check on October 3 at 00:35 IST. This is separate from the successful
6R release and is retained as a rollout limitation, not silently marked green.
See the current handoff for the newest independently observed live revision.

## Scoped closure

MEDIA-06 passes for cooperating writers using the common staging root, including
measured bounded-file behavior, cross-process claims, inherited readers, source
accounting and capacity-refusal retry. This is not protection against an unrelated
process filling the filesystem or a universal production throughput certificate.
No real production media transaction or contention probe was run. MEDIA-07 legacy
and incomplete metadata lifecycle remains a separate open obligation.

Ledger: 53 obligations — 22 passed, 27 untested, one failed, three external.
Private evidence is under `.audit-evidence/backend-section-06r/`. Unrelated receipt
edits and Section 1 evidence were excluded from the release.
