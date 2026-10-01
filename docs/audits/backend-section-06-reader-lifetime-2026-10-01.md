# Section 6I — preview reader lifetime after parent termination

Status: local investigation complete; crash-retention finding remains open.
Application baseline: `bc2fc0976196d996fba2fcca25d399cb60f9049f` (Section 6H).
No production runtime, schema or mobile change is part of this investigation.

## Result

An actual FFmpeg child outlives a SIGKILL of its Node parent and can remain alive
past the configured 30-second timeout. A missing parent PID plus that timeout is
therefore insufficient proof that a staging directory has no readers. Automatic
cross-worker deletion is not safe under the current ownership contract.

This extends Section 6H's generic delayed child reader with the real
`runVideoPosterFfmpeg` helper and installed FFmpeg 6.0 binary. Two identical
readers block on isolated POSIX FIFOs. The control retains its Node parent;
the second parent's PID alone receives SIGKILL. The observed results were:

| Check | Result |
| --- | --- |
| Control killed by the configured parent-owned timer | 30,005 ms, SIGKILL |
| Orphan alive immediately after parent death | Yes |
| Orphan still alive 31,521 ms after parent death | Yes, process state `S`, not a zombie |
| Audit processes and fixture files cleaned | Verified |
| Script type check and targeted lint | Pass |

The Node runtime was v22.17.0 on macOS. A Linux Node 24 container is available
but has no FFmpeg binary; no Linux/production process-lifetime result is claimed.
The FIFO is an injected blocked-input condition, not a file accepted through the
production staging route, which writes a regular file. This does not prove a
remotely triggerable hung decoder, a production disk incident, or scratch
retention across Vercel container replacement.

The first exploratory run killed the parent shortly after spawn and the child
exited before the deadline. Its startup was not synchronized, so it establishes
neither a reliable termination guarantee nor the cause of that exit. Subsequent
probes wait for the FFmpeg startup banner and confirm the child is alive before
fault injection. Two later exploratory runs and the reusable direct-source
probe reproduced survival. Initial output/harness failures are retained privately.

## Repeatable probe

Run from the repository root:

```sh
npx tsx scripts/audits/audit-video-poster-owner-lifetime.ts
```

The script imports the actual helper, invokes the installed binary, observes
real child creation without changing its arguments/options, and runs for about
35 seconds. It accesses no database, network service or provider. `mkfifo` and
`ps` must be available. It kills only fixture-owned processes, checks command
identity before signalling a formerly orphaned PID, and removes its temporary
files. Exit 1 means the orphan finding reproduced; exit 2 is an inconclusive
probe/error. Exit 0 means this particular run did not observe the orphan beyond
the timeout, not that every parent-death ordering is safe.

The [Node child-process documentation](https://nodejs.org/api/child_process.html)
describes timeout signalling by the parent. FFmpeg's
[`-timelimit`](https://ffmpeg.org/ffmpeg.html) limits CPU user time, so adding that
option would not supply the missing wall-clock guarantee for blocked input.

## Linux inherited-lock proof

A separate network-disabled Linux container (Node v24.18.0, existing
`public.ecr.aws/supabase/storage-api:v1.62.5` image) exercised an inherited file
lock on a 4 MiB tmpfs. The owner opens a lease file, obtains `flock` through a
helper sharing its open descriptor, and passes that descriptor to a child via
`spawn` stdio. After parent-only SIGKILL:

- A separate claimant is denied while the owner is alive (exit 1).
- The claimant is still denied while only the orphan reader holds the descriptor
  (exit 1), and that reader successfully opens and reads all 614,400 media bytes.
- After the reader closes its descriptor, the claimant acquires the exclusive
  lock (exit 0) and removes the fixture while holding it.

This validates a candidate primitive with a generic Node reader, not integration
with FFmpeg, publication races, every failure ordering or production packaging.
The first prototype also attempted to disconnect already-closed parent IPC after
releasing its lock; that harness error is saved. A corrected rerun gates the
disconnect and passes without stderr. Container removal destroys all fixtures.

[Linux flock documentation](https://man7.org/linux/man-pages/man2/flock.2.html)
explains the descriptor lifetime and exec inheritance. An implementation must
close its descriptor rather than explicitly unlock a shared open description:
an explicit unlock would also remove a surviving child's protection. The current
Vercel artifact has no established `flock` executable contract; availability,
packaging and supported filesystem behavior must be verified before wiring this
prototype into production. It does not justify silently invoking a host command
or treating missing lock support as permission to delete.

## Cleanup decision and implementation gates

| Candidate | Decision |
| --- | --- |
| Remove directories after their parent PID disappears | Reject: surviving child readers are reproduced |
| Add an age cutoff based on the current 30-second timeout | Reject: the timeout is lost with the parent |
| Treat a database lease expiry as file ownership ending | Reject: it does not stop an old local reader |
| Sweep every `remote-media-*` name | Reject: legacy directories have no verifiable owner/reader record |
| Check free disk bytes before writing | Useful admission signal, but not a reservation or reclamation proof; concurrent writers still race |
| Reclaim only a new namespace using an OS-held lease inherited by every reader | Primitive passes Linux/Node 24 owner-death proof; integration and packaging remain unverified |

A reclamation implementation must first prove all of the following:

1. The lease is acquired before a workspace becomes reclaimable, and a child
   inherits protection atomically with spawn. Recording the child PID afterward
   leaves a parent-death window.
2. A reclaimer can acquire exclusive ownership only after the owner and every
   child reader release their protection, including after SIGKILL. PID reuse,
   inaccessible process metadata, and an unknown filesystem/namespace fail closed.
3. Reclaimers cannot remove live files during concurrent imports or race one
   another. Symlinks, foreign/legacy directories and malformed metadata are never
   deletion authority. Scan work is bounded.
4. Disk admission separately accounts for active imports and preview scratch;
   per-process counters or one `statfs` read cannot reserve shared capacity.
5. Tests kill each process at allocation, lease publication, child spawn and
   release boundaries, then prove both active-reader preservation and eventual
   reclamation after the final reader exits. Repeat on the Linux runtime before
   making a deployment claim.

No speculative stale-file sweep or extra production timeout is shipped. The
open failure mode remains the conditional disk exhaustion reproduced in Section
6H. Next work is production-compatible lock packaging plus reader integration and
publication/race tests; it must meet these gates before being wired into staging. Other
preview/rendition scratch namespaces, workflow/template recovery and genuine
provider/storage/push delivery remain separate audit obligations.

Private evidence: `.audit-evidence/backend-section-06i/`. Section 6H remains the
latest deployed application; its release records and unrelated local edits are
preserved. This investigation needs no deployment.
