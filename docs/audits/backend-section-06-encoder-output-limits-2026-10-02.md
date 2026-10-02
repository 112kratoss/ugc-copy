# Section 6Q — bounded encoder output in actual runners

Date: 2026-10-02. Base: `626f398ca01d179113663868d76d658e332184e1`.
Status: implemented and locally verified; PR/exact-main Quality and release pending.

## Reproduction and change

The application rendition runner previously encoded an entire output before
checking whether it saved space. A real 12-second, 640×360 black source of 2,003
bytes produced 13,007 bytes before being discarded. The committed regression
`scripts/audits/audit-media-output-limits.ts` fails against the original runner:
13,007 exceeds the 2,048-byte useful output budget. Its filesystem observation
records the output immediately before real cleanup; it does not replace FFmpeg.

`media-encoder-limit.ts` applies the inherited kernel file-size limit proven in
Section 6P. Fixed shell source uses positional executable/argument values, disables
core dumps, sets the limit and execs FFmpeg. Source/output lease descriptors,
process identity and timeout targets survive exec. No unbounded fallback exists.

An asynchronous, coalesced first-use probe writes 8 KiB under a one-unit limit in
a leased scratch workspace. Only verified 512/1,024-byte units are accepted;
other results or unavailable enforcement reject encoding. The probe has a 10-second
SIGKILL timeout and waits for close before cleanup. Successful capability is cached
per process; failures can retry on later work. Source leases stay held while this
probe runs. The existing abort check is repeated after calibration.

| Writer | Maximum file length | Limit outcome |
| --- | --- | --- |
| Rendition | 85% of source bytes, rounded up to KiB (minimum 1 KiB) | Existing `not-smaller` skip; source fallback remains available |
| Poster intermediate JPEG | 16 MiB | Reject; do not retry the same limit failure at one second |
| Eight-second silent teaser | 8 MiB | Reject; partial output is not returned |

The rendition's original exact savings check remains after encoding. Poster and
teaser also reject files at their cap even if a child were to exit successfully.
Read-only metadata probes are unchanged. This adds no dependency, SQL or mobile
change. The caps bound file length; they do not reserve filesystem blocks or
metadata, bound decoded memory, or prevent concurrent ENOSPC.

## Verification

- macOS Node 22.17.0 / FFmpeg 6.0: actual rendition stops at 2,048 bytes, raises
  the expected skip, and leaves no workspace. Before-fix failure is retained.
- Linux Node 24.21.0 / FFmpeg 8.1.2, network disabled and 64 MiB private tmpfs:
  1,996-byte source stops at 2,048 bytes and cleans up.
- The actual scratch lifetime regression on Linux passes for poster, rendition
  and teaser. Paused real FFmpeg inherits both leases, survives Node owner death,
  prevents premature reclamation, and permits a fresh process to reclaim both
  workspaces after exit. Normal outputs, invalid-media failures and cancellation
  also clean up. The existing poster lease regression passes on macOS beyond
  the parent's 30-second timeout after owner death.
- Eight capability tests cover coalescing, cleanup, failure/retry and invalid
  budgets. The initial mock did not replace the CommonJS default spawn export;
  correcting that fixture makes the intended failure injection effective.
- Local full web run: 838 files passed, 10 skipped; 6,406 tests passed, 121 skipped.
  Final focused runner/capability run: 59 passed, including the additional typed
  poster-limit failure test. App, script and test type projects pass.
- Repository lint passes with two pre-existing unused-variable warnings when
  private `.audit-evidence/**` is excluded. Initial unrestricted lint traversed
  generated private bundles and failed; none of those bundles is included in the PR.
- Quality now runs the committed actual-output regression alongside the existing
  real scratch/abort/orphan regression. Final CI build/native tracing is still required.

Private logs and reproducible Linux bundling inputs are preserved under
`.audit-evidence/backend-section-06q/`; prior evidence remains intact. The Linux
bundle uses application source and external native fs-ext/sharp dependencies,
with only the FFmpeg path and server-only environment marker adapted for Node.

## Remaining scope

No production encode or Vercel launcher capability is certified by local tests.
The application checks enforcement in its actual runtime before its first encode;
standard release health alone does not exercise media encoding. Unsupported
runtime behavior therefore rejects preview work instead of running without a cap.

MEDIA-06 remains failed/open: shared cross-process reservations must account for
completed source files, overlapping writers, retained orphans, filesystem blocks
and metadata headroom. MEDIA-07 remains failed/open for old/unpublished metadata
ownership policy. Do not delete legacy directories based on age alone. The ledger
remains 53 obligations: 21 passed, 27 untested, 2 failed, 3 external.
