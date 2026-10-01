# Section 6J — inherited staging leases and crash reclamation

Status: implemented and locally verified; full web suite passed; PR/release pending.
Baseline: `bc2fc0976196d996fba2fcca25d399cb60f9049f`.

## Behavior and scope

Section 6H reproduced conditional ENOSPC after SIGKILL retained staged bytes;
Section 6I proved that a preview child can survive its parent. The new staging
workspace holds an OS file lock and passes its open descriptor to FFmpeg as part
of spawn. A separate cleanup claimant can acquire the lock only after the owner
and its child readers close their descriptors. No explicit unlock releases a
shared lock prematurely.

Imports now use a private `magicbooklet-staging-v1/item-*` namespace. An exact
ready marker is written under the lock before media staging begins. A bounded
scan (128 directory entries, coalesced within one process) runs before new
staging. It reclaims only published workspaces with an exclusive lock. Symlinks,
foreign entries, malformed markers, legacy `remote-media-*`, active owners and
surviving readers are preserved. Unknown filesystem types are not swept; the
current sweep allowlist is Linux tmpfs/overlayfs/ext4 and macOS APFS.

Explicit cleanup also takes a separate exclusive lock, reports EBUSY for a live
reader, and remains retryable. Payload deletion precedes marker/lease removal,
so failed payload cleanup retains deletion authority. If deletion reaches an
empty directory but cannot remove it, only its original owner can finish that
same empty inode on retry.

The lock descriptor passes through the single-output and multiple-output preview
paths into both poster seek attempts. Sharp and upload streams stay within their
existing awaited owner lifetime. This batch does not manage the separate poster,
frame or rendition scratch directories.

## Verification

- Actual helper/FFmpeg lease probe failed before descriptor inheritance, then
  passed afterward on macOS/Node 22 with FFmpeg 6.0.
- The same probe passes in an isolated Linux/Node 24.18 container with FFmpeg
  8.0.1: the orphan remained alive 31,503 ms beyond parent death while retaining
  its lock; control timeout was 30,025 ms. After child termination the claimant
  acquired the lock. Cleanup verified. This injected FIFO stall is not evidence
  that production media can trigger a hung decoder.
- Linux actual workspace probe reclaims a killed owner, preserves a live owner's
  bytes, and completes explicit cleanup. No network is used during the probes.
- 118 focused cases pass, including 14 workspace tests: allocation/publication
  kills, active and inherited readers, separate-process and same-process cleanup
  races, symlinks, malformed/missing markers, and partial deletion retry.
- All nine real database/process-kill recovery cases pass, with reclaimed
  staging workspaces checked after recovery (child-only case intentionally skips).
- Full web suite: 6,173 passed, 118 DB/child-only skips.
- App/test/script typing and targeted lint pass. Production build and packaged
  FFmpeg/sharp/native-lock checks pass. The native lock binary is present in all
  162 API route traces, and the build check verifies lock exclusion/release.

CI now runs the real FFmpeg inherited-lock probe using the installed binary and
Node 24, in addition to the normal suites and packaging checks. `fs-ext` 2.1.1 is
pinned and externalized; native compilation is required at install time. There
is no runtime dependency on a system `flock` command. Local dependencies were
installed inside this checkout; the previous shared node_modules symlink was
preserved in private evidence, and the primary checkout was not modified.

Harness corrections are retained privately: the worker initially lacked the
server-only alias; a fresh npm install needed the repository's existing
brace-expansion patch reapplied; Linux FFmpeg's banner differed and BusyBox ps
truncated command identity, so the Linux probe reads /proc. The cleanup probe
waits for actual lock release rather than assuming process observation and
kernel descriptor release occur in the same instant. These are not additional
production defects.

## Limits and remaining work

This removes abandoned payloads only on a subsequent staging attempt, within a
bounded scan. It is not a background janitor, a disk reservation, a fairness
promise under more than 128 persistent entries, or proof that Vercel retains
scratch across replacement. Incomplete initialization can leave empty/unmarked
metadata directories; these are deliberately not swept. Legacy files and other
scratch namespaces remain untouched. Disk admission and their lifetime policies
are separate obligations. Production deployment and its runtime checks are still
pending; local Linux/Alpine evidence does not substitute for the Vercel build.

No SQL migration, mobile contract/runtime change, OTA, provider charge, customer
repair or production fixture is involved. Private evidence:
`.audit-evidence/backend-section-06j/`. Section 6H release records and Section 6I
investigation are carried with this batch; unrelated local edits stay separate.
