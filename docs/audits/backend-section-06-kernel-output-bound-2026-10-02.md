# Section 6P — kernel output-bound proof

Date: 2026-10-02. Application baseline: `626f398c`.
Status: local candidate-mechanism proof; **not integrated or deployed**.
No application, dependency, database or mobile runtime changes.

## Why this probe

Section 6O showed that adding FFmpeg `-fs` does not impose a strict file-size
ceiling. Cross-process disk admission needs an enforceable writer bound before
an output reservation can mean anything. This probe tests an operating-system
file-size limit inherited through `exec`, retaining the existing staging leases.
It does not claim a shared-capacity fix.

The candidate launcher invokes `/bin/sh` with a fixed script and positional
arguments. The shell disables core dumps, sets its file-size limit, then replaces
itself with FFmpeg. The executable, input and output paths are never interpolated
into shell source. Inherited source/output lease descriptors and Node timeout
options are supplied unchanged. The rendition arguments, metadata parser and
staging workspace implementation are bundled from the current checkout.

The underlying primitive is the inherited process file-size resource limit:
[getrlimit specification](https://pubs.opengroup.org/onlinepubs/7908799/xsh/getrlimit.html).
Shell units require care: the [Bash manual](https://www.gnu.org/s/bash/manual/html_node/Bash-Builtins.html)
documents different increments in POSIX mode. The probe does **not** assume a
unit based on that documentation or the operating system name; it measures the
actual selected shell by trying to write 8 KiB with a one-unit limit.

## Results

Real regular source: 640×360, 30 fps, 12 seconds, over 5 MiB. No external media,
provider, Storage or database calls. Linux runs on a dedicated 64 MiB tmpfs with
network disabled. macOS uses an isolated temporary directory.

| Environment | Measured shell unit | FFmpeg | Node |
| --- | ---: | --- | --- |
| macOS `/bin/sh` | 1,024 bytes | static 6.0 | 22.17.0 |
| Linux Alpine `/bin/sh` | 512 bytes | 8.1.2 | 24.21.0 |

After converting the requested byte cap using the measured unit:

| Operation / cap | macOS bytes | Linux bytes | Outcome |
| --- | ---: | ---: | --- |
| Rendition / 4,096 | 4,096 | 4,096 | SIGXFSZ; rejected |
| Rendition / 65,536 | 65,536 | 65,536 | SIGXFSZ; rejected |
| Rendition / 1,048,576 | 522,680 | 522,673 | Exit 0; complete 12-second output |
| Poster / 4,096 | 4,096 | 4,096 | SIGXFSZ; rejected |
| Poster / 65,536 | 19,357 | 19,368 | Exit 0 |
| Poster / 1,048,576 | 19,357 | 19,368 | Exit 0 |

Limits restrict writes, not reads: all cases can read the source larger than
their configured output cap. Allocated payload blocks are recorded separately;
this file-length proof is not a filesystem metadata/total-block reservation.

Additional controls pass in both environments:

- Invalid limit or missing executable exits nonzero without running unbounded.
  The first harness run assumed missing-executable exit 127; macOS returned 126.
  The assertion now checks the required nonzero outcome and records the code.
- Output paths containing spaces, semicolons, dollar-command syntax and backticks
  are passed literally; neither sentinel command executes.
- A process can write **two 4,096-byte files with a 4,096-byte per-file limit**.
  Total payload becomes 8,192 bytes. The primitive is not aggregate disk admission.
- After the real FFmpeg source and output open, the probe pauses it with SIGSTOP,
  kills only its Node owner, and waits beyond the owner's configured 3-second
  timeout. The orphan remains alive with both inherited leases held.
- A fresh process reclaims zero active workspaces. Resuming the orphan leaves
  output at exactly 65,536 bytes; the over-5-MiB source remains intact. After
  the encoder exits, a fresh process reclaims both workspaces.

SIGSTOP is an explicit scheduling barrier, not evidence of a remotely triggerable
hung decoder. No Vercel runtime capability or production media operation is
certified by these local controls.

## Decision and remaining integration contract

The kernel primitive passes the bounded proof. A launcher can keep MP4 faststart
and existing encoder arguments while enforcing a per-file bound. Do not replace
this with periodic size polling or FFmpeg's own `-fs` flag.

Before application integration:

1. Establish and verify the selected production shell's units and supported
   resource-limit behavior; do not silently assume 512-byte units across systems.
   Missing/unsupported enforcement must fail closed, not run an unbounded encode.
2. Set explicit poster/rendition/teaser byte budgets and preserve normal optional
   rendition fallback. Reaching the cap must never publish incomplete output or
   be misreported as a successful encode.
3. Exercise the actual application runners with the launcher: abort/timeout,
   spawn failure, successful encoding, cap violation, and parent death. Both
   source and output descriptors must survive the shell-to-FFmpeg exec.
4. Couple output and source budgets to cross-process admission. Record how
   completed, immutable source bytes and still-unwritten allowances are counted
   against filesystem free space; avoid both double-counting existing bytes and
   crediting writes that can still be truncated/replaced. Metadata and external
   writers require headroom. Test admission and recovery on a bounded filesystem.
5. Verify packaging and production runtime prerequisites through the standard
   Quality/release path before claiming deployment. Current live build remains
   `626f398c`; this probe changes no production behavior.

MEDIA-06 and MEDIA-07 remain failed/open. No checklist count changes: 53 total,
21 passed, 27 untested, 2 failed, 3 external. Legacy/unpublished metadata policy
is still separate from limits on newly created files.

## Evidence and cleanup

Private `.audit-evidence/backend-section-06p/` contains the self-contained probe,
bundled actual runtime helpers, pinned-base Dockerfile, macOS/Linux results,
initial harness failure, build log and verification hashes. All fixture processes
exit before cleanup; both runs assert removal of their temporary roots. The
dedicated container is removed automatically, and its image is removed after
recording its identity. Existing database containers and unrelated edits remain.
