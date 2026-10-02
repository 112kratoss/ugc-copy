# Section 6O — current baseline and output-limit investigation

Date: 2026-10-02. Baseline and independently verified live build:
`626f398ca01d179113663868d76d658e332184e1`.
Active checkout: `auth-section-one`, branch `codex/media-capacity-admission-6o`.
No application, migration, dependency or mobile runtime change in this batch.

## Incorporating the other edits

Remote main advanced by 15 merged PRs after Section 6N: #258–#272. They include
reference media/remix handling, notification deferral/delivery/deduplication,
multi-device sign-out behavior, audio labels and mobile video caching. The audit
checkout fast-forwarded without conflicts. Existing local release evidence,
Section 1 files and the unrelated Section 5 receipt-report edit were preserved.
The primary checkout and other checkouts/containers were not modified.

The staging, staged remote media, poster, rendition and committed process-crash
probe files are byte-for-byte unchanged from Section 6N. New generation and
notification behavior was read before selecting compatibility checks; old
probe bundles are not evidence of the updated notification implementation.

Section 6N exact-main Quality `36875154079` and standard production release
`36876633477` succeeded. The release completed October 1 at 14:31:58 UTC
(20:01:58 IST), including protected production health. Current main release
`36975169861` succeeded October 2 at 06:49:45 UTC (12:19:45 IST). A fresh probe
on resumption verifies current SHA, feed 200, admin payout login redirect 307,
and unsigned Kie webhook 401. No stale release was dispatched. See the updated
[6N release record](backend-section-06-media-scratch-release-2026-10-01.md).

## Verification on the updated checkout

- 194 tests across nine suites pass: staging, poster, rendition, import worker,
  generation services, background failure notification, deferred notification
  and mobile notification behavior. This is scoped compatibility verification,
  not complete coverage of all 15 PRs.
- All nine actual worker-process termination cases pass using the isolated
  Postgres instance at localhost:55322. One child-only harness case is skipped
  in the parent run as expected. Media transport/provider/preview boundaries
  remain synthetic; queue, staging, leases, notification dedupe and settlement
  code run against the database as in the existing suite.
- Separate cleanup readback: zero `audit-crash-*` generations, completion jobs
  and output-import jobs. This suite was not pointed at production or the
  primary development database.

## Candidate output limit — not suitable as a hard reservation

The next MEDIA-06 step needs an output bound. An isolated local probe uses the
actual `buildRenditionArgs` and metadata parser with a regular generated 12-second
640×360 MP4. It adds **only the proposed `-fs` argument** to the command. Current
application code does not set this flag. FFmpeg is the installed macOS static
6.0 binary; Node is 22.17.0. No network, provider, Storage or database calls.

| Candidate cap (bytes) | Actual output bytes | Duration (seconds) | Exit code |
| ---: | ---: | ---: | ---: |
| None (control) | 522,680 | 12.00 | 0 |
| 16,384 | 266,960 | 6.03 | 187 |
| 65,536 | 266,960 | 6.03 | 187 |
| 262,144 | 266,960 | 6.03 | 187 |

All limited outputs exceed the requested cap. They would satisfy the existing
size-savings comparison, but **the current runner rejects their nonzero exit**;
this is not a reproduced publication of truncated media. The initial probe
incorrectly expected successful truncation, then was corrected to record actual
exit status. The failed initial probe is preserved. Do not infer Linux or other
FFmpeg-version exit behavior from these macOS observations.

This disproves treating the proposed `-fs` value as a strict reservation size.
It does not define a universal overshoot allowance. Polling file size or assuming
output is smaller than input also does not establish a hard bound. No speculative
output-cap patch was introduced. The prior 6N output-expansion observation and
6K simultaneous free-space oversubscription remain relevant.

All temporary media was removed after synchronous child completion. Private
reproducible script, source hashes and results are in
`.audit-evidence/backend-section-06o/`. Section 6N live verification is saved
under `.audit-evidence/backend-section-06n/`.

## Remaining work

MEDIA-06 stays failed/open: choose and verify an enforceable writer-bound
mechanism, then serialize reservations across processes and retain them until
all inherited writers exit. Include filesystem allocation/metadata headroom and
source-plus-output overlap. Do not implement a single-process semaphore or a
plain free-space preflight as shared admission.

MEDIA-07 stays failed/open for legacy and unpublished metadata policy. New leased
scratch recovery is deployed, but old names/ages/PIDs are not deletion authority.
The scoped ledger remains 53 obligations: 21 passed, 27 untested, 2 failed and
3 external. Continue workflow execution/recovery after the bounded media work;
these checks do not close provider/operator or overall capacity certification.
