# Section 6R — bounded writers still contend for shared capacity

Date: 2026-10-02. Runtime: merged Section 6Q `a8dd6c1f`.
Status: reproduction and fix verified locally; CI and release pending.
The reproduction below used a8dd6c1f; the implementation also incorporates main
1f31715c and its seven later product/workflow/notification commits.

Section 6Q limits individual encoder files. This probe establishes the next
shared-admission boundary using actual bounded rendition runners, rather than
only concurrent source downloads as in Section 6K.

A dedicated Linux/Node 24.21.0 / FFmpeg 8.1.2 container runs with networking
turned off and an 11,010,048-byte (10.5 MiB) private tmpfs. FFmpeg generates the
source on the container's separate writable layer; the real application stages
it into the constrained filesystem. Each source is 5,151,202 bytes. The actual
application output limit is 4,378,624 bytes per rendition.

Workers hold at a barrier after staging, then start their real encoders together.
A second barrier delays removal of each real output until both writers have
finished, making overlapping retention deterministic. It changes cleanup
scheduling only: FFmpeg, byte caps, source staging, locks, file writes, error
handling and eventual cleanup are actual application code. This is a controlled
retention scenario, not a measured production concurrency pattern or incident.

| Scenario | Observed output | Result |
| --- | --- | --- |
| One worker | 522,673 bytes | Complete successful rendition; normal cleanup |
| Two retained sources and concurrent writers | 421,888 and 266,240 bytes | Both encoders report actual ENOSPC, below their individual caps; no output result returned |

At the concurrent checkpoint, available filesystem bytes are zero. Both sources
still match the original byte-for-byte. A separate parent-process sweep
reclaims zero live workspaces. After the fixture releases cleanup, both actual
worker paths leave the staging namespace empty. The single-worker control has
5,324,800 bytes available at its corresponding checkpoint.

No provider, Storage, database, charge or notification is involved. This does not
extend the earlier queue/settlement recovery certificate to a new upstream
caller. It proves that per-file limits alone do not prevent shared ENOSPC and
that these particular failed encodes reject and clean up without deleting their
live source bytes.

Private reproduction, bundled actual source and results are preserved under
`.audit-evidence/backend-section-06r/`, including `concurrent.ts`, `build.cjs`,
`concurrent-verified.json` and a hash manifest. The initial successful reproduction
is also retained as `concurrent.log`; the final run adds source-integrity, live
reclamation and per-file bound assertions. Container cleanup is automatic; no
primary/local database resources are changed.

MEDIA-06 remains failed/open. Next: atomically reserve remaining writer growth
across processes while retaining completed-source and inherited-child accounting;
include calibration work, metadata/block headroom, malformed or legacy state,
abort and crash release. A free-space scan alone is not admission, and reserving
an already allocated source twice is also incorrect. MEDIA-07 ownership policy
remains open. The scoped 53-obligation ledger is unchanged.

## Shared admission implementation

All seven production staging allocations now declare an enforced write ceiling:
remote imports use the media-kind stream limit, Blob sources use their byte size,
encoder outputs use their kernel cap, and the shell capability probe reserves its
8 KiB attempted write. No HTTP Content-Length hint determines a reservation.

Admission takes an asynchronous exclusive flock on the persistent private staging
root directory inode. It scans live lease claims, checks actual filesystem free
space and inodes, and publishes the new immutable claim while still holding that
lock. Claim publication happens before the caller can write payload bytes. Lock
contention is bounded to five seconds; insufficient capacity returns the retryable
`STAGING_CAPACITY` error before a new workspace is allocated. Unknown filesystems
and live legacy/malformed claims fail closed instead of admitting unbounded work.
The existing supported local filesystem list is unchanged.

A reservation lives in the same lease file whose descriptor FFmpeg inherits.
Parent death cannot release a surviving encoder's claim. Unlocked dead owners
cannot grow further; their actual retained bytes still reduce statfs free space,
regardless of whether marker rules permit reclamation. This does not expand
legacy deletion authority.

The accounting intentionally favors safety over maximum concurrency: while a
writer runs, retain its whole ceiling in addition to the partial bytes already
allocated. This conservative over-reservation avoids races with output truncation
or MP4 faststart rewrites. After a source pipeline closes, an explicit complete
marker releases its future-growth reservation under the same admission lock.
The completed source's occupied bytes remain in statfs and its lease stays held
through readers. Missing or partial completion markers do not release growth.
This is different from retaining the full source reservation after completion.

Each active workspace adds 32 KiB metadata headroom. Filesystem headroom is 1% of
capacity, clamped to 1–64 MiB; an inode guard retains 32 entries plus four future
entries per active workspace. These are explicit conservative policy margins,
not guarantees against uncoordinated applications filling the filesystem. The
coordination scope is cooperating writers using this common staging root.

## Fix verification

- `scripts/audits/audit-staging-admission.ts` fails against the old implementation:
  both concurrent writers are admitted where only one reservation fits (2 vs 1).
  With the fix, exactly one is admitted and the loser allocates no workspace.
- The same real-process test verifies completed-source accounting, rejection of
  partial completion markers, claims held by inherited readers after owner death,
  reclamation after child exit and resumed admission. Five repeated Linux runs
  passed, followed by the final run with the partial-marker assertion.
- Initial orphan assertions assumed observing a zombie process meant its file
  lock was already released. Instrumentation caught the lease still busy. The
  final fixture waits for actual lease-authorized reclamation, with a deadline;
  it never uses process state as deletion authority. Initial failed logs remain.
- On the original 10.5 MiB tmpfs, the single-worker control still produces a
  complete 522,673-byte rendition. With two requests, one succeeds and one is
  rejected before staging with STAGING_CAPACITY. No encoder hits ENOSPC; the one
  retained source matches byte-for-byte, a sweep preserves it, and cleanup empties
  the namespace. The rejected request is never sent to FFmpeg.
- A separate 128 MiB tmpfs with only 64 inodes admits five writers, rejects further
  allocation, and lets all five finish and seal. Free inodes go from 47 to 37;
  no admitted writer exhausts metadata capacity, and cleanup succeeds.
- The actual Linux poster/rendition/teaser normal, malformed-media, cancellation,
  owner-kill and fresh-sweep regressions pass, as does the 2,048-byte output cap.
- A real isolated-Postgres worker test holds a genuine competing reservation.
  Import is retried before upload with the generation still processing, no refund,
  and balances 380 total/80 promotional after the original 120-credit hold.
  Releasing capacity and advancing only fixture retry eligibility completes one
  upload and one notification without another charge; duplicate processing is idle.
  All ten worker tests pass (one child-harness skip). Independent SQL readback finds
  zero remaining audit generations, completion jobs or import jobs.
- On updated main, the final web suite passes 6,583 tests (127 skipped). The
  final repair-focused suite passes 70 cases; the earlier staging/runner suite
  passes 73 cases. App, script and test type projects pass. Lint has no errors and two
  existing warnings with private generated evidence excluded.

Quality now runs the actual cross-process admission regression. No SQL migration,
mobile behavior, dependency or production contention probe is introduced. Final
CI/native packaging and standard release remain required before closing MEDIA-06.
MEDIA-07 legacy/unpublished metadata policy and the wider audit remain open.

## Repair retry accounting

Caller review reproduced two related pure-logic failures before fixing them:
capacity refusal consumed the last rendition attempt (3 instead of 2), and a
leased claim with reserved ordinal 3 was skipped by the application filter (0
attempted instead of 1). The database increments the count when claiming, so the
leased final ordinal is valid; unleased work still requires a count below three.
Claims beyond ordinal three remain rejected.

Preview and rendition failures now restore the refused reservation only for the
typed capacity error. Teaser and private-playback claims do not return their
ordinal, so deferral reads it under source/lease guards and conditionally updates
that same count. A changed lease/source or duplicate deferral cannot decrement a
new worker's allowance. Ordinary encoding errors still consume an attempt. The
entrypoint tests verify no upload on denial; the helper tests verify stored-row
mutation, duplicates and stale ownership. These are application query/logic
regressions, not a new database concurrency certificate. The real database import
recovery evidence above is a separate caller and remains explicitly scoped.

The final isolated worker rerun passed all ten cases (one harness skip); the final
Linux admission run passed with the current source. One rerun initially mounted
over the container dependency directory and failed to resolve fs-ext. Correcting
the fixture mount restored the same installed native module; no runtime change
was made to address that harness error. Failed and passing logs are retained.
