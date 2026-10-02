# Section 6S — recover interrupted staging initialization

Date: October 3, 2026. Baseline: 6R merge `20862a0b`, then current main
`24194f1d`. Status: implemented locally; final CI and release pending.

## Reproduced failure

An isolated Linux/Node 24.21 container, with networking disabled and a 128 MiB
scratch tmpfs containing 64 inodes, kills a real allocator immediately after
mkdtemp returns. After 31 SIGKILLs, 31 empty directories remain. The sweep removes
none, and the next 4 KiB allocation is refused with STAGING_CAPACITY. All 128 MiB
remain free; only 31 inodes remain. The inode guard correctly prevents exhaustion,
but initialization metadata prevents subsequent admission indefinitely.

Permanent regressions against the baseline fail at five actual kill points:
after directory creation, before publication, after lease open, after claim write,
and after ready-file open. The already-written ready marker was reclaimable and
remains the positive control. No exception simulates owner death.

## Initialization and publication authority

New initialization uses an `item2-` prefix while holding the existing shared root
admission lock. A sweep acquires that same lock before inspecting initialization
metadata. It can remove only an empty directory or validated lease/ready metadata
with no payload or unknown entries. Any existing lease must also be exclusively
acquired through a separate descriptor; an inherited child wins even without a
complete marker. Symlinks, foreign content and unknown payloads remain untouched.
Deletion uses individual unlink/rmdir operations, never recursive payload removal
under this new authority. The existing published-payload reclamation protocol is
unchanged, including lease ownership and ready-marker checks.

Before releasing admission, the allocator atomically renames the fully initialized
directory into the existing `item-` prefix. This is necessary for compatibility:
an earlier prototype left published work under `item2-`, and the actual 6R
allocator admitted a second reservation it should reject. That private regression
fails before the rename and passes after, in both old-to-new and new-to-old
directions. All capacity-aware allocators hold the same root lock. Publication
checks for an existing destination and chooses a different name on collision;
it does not intentionally replace a legacy directory. A permanent collision test
preserves the existing workspace's bytes and lease.

A crash before publication leaves identifiable initialization metadata; a crash
after the atomic rename leaves the original published-marker/lease protocol.
No payload or reader starts before the initialized workspace is returned. The
shared root remains unchanged so coordinating old and new workers account for
each other. Pre-admission writers and unrelated processes remain outside the
6R cooperation guarantee.

## Verification and limits

- On the 64-inode filesystem, 80 kills at each of five checkpoints (400 total)
  leave no initialization metadata after reclamation; subsequent admission works.
- Real-process controls retain a live allocator's empty directory, wait for its
  root lock to release, retain inherited readers and preserve unknown/legacy files.
- Permanent tests also cover partial claim/ready writes, malformed metadata,
  publication collisions and the published name's compatibility. Workspace-only
  suite: 38 passed. Updated-main focused staging/encoder suites: 83 passed.
- Actual Linux poster/rendition/teaser normal/decode-failure, cancellation and
  orphan-lifetime controls pass. The output cap remains 2,048 bytes; cross-process
  admission and inherited claim controls pass. An initial container invocation
  omitted FFMPEG_PATH; the corrected fixture explicitly uses its installed
  `/usr/bin/ffmpeg`. No runtime workaround was added for that harness error.
- All ten real isolated database worker cases pass on updated main, with one
  child-harness skip. The fixture left by the interrupted prior session was
  identified by its exact task ID, test prompt, reserved identity and creation
  time, and removed on isolated port 55322 before rerunning. No other fixture,
  checkout or customer identity was changed.
- All three type projects and targeted lint pass. A full suite run under shared
  host load encountered timeouts; later interrupted runs have no completed
  result and are not counted as passes. The completed updated-main suite, with
  two workers, passes 6,648 tests (129 skipped). Final CI/release remain pending.

Automatic legacy policy is intentionally conservative: older unpublished `item-`
directories and the five pre-lease namespaces still lack enough ownership evidence
for an invocation to delete them. Preserve them. Retire their ephemeral storage
only with the entire execution environment after every worker and inherited
reader is stopped; a deploy SHA, age, parent PID or one process-list view is not
that proof. No production legacy-volume retirement has been verified here.
MEDIA-07 therefore remains open for that legacy operational evidence. No production
scratch was deleted. Directory enumeration remains linear (OPS-03), and this is
not a production latency or capacity certificate.

Private reproducible scripts, baseline/candidate/final results and failed harness
logs are under `.audit-evidence/backend-section-06s/`. No migration, dependency,
mobile change, provider charge or production contention probe is introduced.
