# Section 6N — media scratch ownership and footprint

Updated 2026-10-01. Baseline: `999c34d5`. Implementation branch:
`codex/media-scratch-leases-6n`. Local verification complete; release pending.

## Reproduction

Real Linux/Node 24.21.0 and FFmpeg 8.1.2, regular locally generated MP4 files,
128 MiB tmpfs, network disabled. No database, Storage or provider calls. The
initial 13 scenarios cover successful poster/rendition/teaser processing,
process termination during processing and after complete output, invalid input,
and a rendition rejected for being larger than its source.

All five old namespaces (`generation-poster`, `generation-frame`,
`feed-rendition-src`, `feed-rendition`, `feed-teaser`) retain directories after
SIGKILL. Successful and decode-failure paths clean up normally. A fresh process
running the actual staging sweeper reclaims zero old scratch directories, both
while an orphan exists and after it exits. This is a reproduced local lifecycle
failure, not an attributed production incident.

The strengthened process probe waits for the actual FFmpeg reader/writer to open
regular media, observes `/proc/<pid>/fd`, then injects SIGSTOP before killing
only its Node owner. FFmpeg retains its input and, for transcodes, its output.
After resumption it exits; the source and output remain. SIGSTOP is a controlled
scheduling barrier, not evidence that ordinary media causes a hung decoder.
An earlier pre-start checkpoint only established an orphan child, not an active
FFmpeg reader; its logs are retained but the strengthened result is authoritative.

The committed regression fails against unchanged runtime code: a fresh process
reclaims **0 instead of 2** abandoned workspaces. A second actual-process
regression reproduced cancellation cleanup returning EBUSY when Node emitted
AbortError before the child released its leases.

## Observed overlapping bytes

These are file lengths at the cleanup boundary and allocated payload blocks,
not universal peak bounds, directory/metadata accounting or capacity certificates.
Fixture: 640×360, 30 fps, 12 seconds; source 5,151,202 bytes.

| Operation | Output bytes | Source + output bytes | Allocated payload bytes |
| --- | ---: | ---: | ---: |
| Poster JPEG before WebP conversion | 19,368 | 5,170,570 | 5,173,248 |
| Full rendition | 522,673 | 5,673,875 | 5,677,056 |
| Eight-second teaser | 352,940 | 5,504,142 | 5,509,120 |

A separate 1,996-byte black-video source produces a **13,022-byte** rendition
before the `not-smaller` check rejects it. Combined file lengths are 15,018
bytes (20,480 allocated). The output/source ratio cannot safely supply an
admission ceiling. The encoder has bitrate/time policies but no enforced disk
output-byte ceiling; capacity work must address actual writes and overhead.

Caller review:

- Remote generation import caps video at 250 MiB and shares its staged source
  with poster extraction; the source lease already reaches the poster reader.
- Blob poster helper has no local byte gate; template publication validates
  assets at 100 MiB, but repair downloads do not independently impose that same
  local check. Do not infer a universal poster-input bound from one caller.
- `withVideoInputFile` rejects above 512 MiB before disk allocation. Playback
  and demo optimization impose 64 MiB; standalone teaser repair imposes 32 MiB.
- Post rendition processing reuses one source, probes it, creates/uploads the
  teaser, then creates the full rendition. Teaser output is removed before the
  full output is created. Source plus current output is the disk overlap; returned
  output buffers and downloaded blobs have a separate memory cost.

## Fix

New scratch files use the existing private staging namespace and lease/marker
protocol. A payload subdirectory supports encoder filename extensions. Each
FFmpeg encode inherits both its source lease (where owned by the helper/caller)
and output lease. Local metadata probes inherit the lease of their input.
All production `withVideoInputFile` callers forward the source lease.

Normal cleanup still runs in `finally`. After owner death, fresh-process cleanup
preserves both workspaces while FFmpeg retains their leases, then reclaims both
once the child exits. Abort handling waits for process `close` and then returns
the original process error, so cleanup follows lease release. The remote URL
metadata probe is unchanged. No migration, provider call, dependency or mobile
runtime change is needed.

Old scratch directories, unpublished metadata and unknown files remain outside
deletion authority. Their names, ages and parent PIDs do not prove exclusive
ownership. Shared disk admission also remains open. MEDIA-07 is therefore
**failed/open**, with the newly created scratch leak fixed locally but legacy
and metadata policy unresolved. The ledger now has 21 passed, 27 untested,
2 failed and 3 external obligations (53 total, unequal scope).

## Verification and evidence

Initial PR Quality `36872492921` passed web unit, mobile, browser and database
checks, then the new process probe found TSX compiler-cache files in its isolated
temp root after media reclamation. The harness now disables child TSX caching;
app cleanup must not remove unrelated compiler files. This corrects probe
isolation without changing runtime cleanup or relaxing media assertions. The
original CI failure is preserved.

- Real failure before implementation: `regression-before.log`, 0 vs 2 reclaimed.
- Actual FFmpeg after fix: three killed owners; live source/output leases
  preserved, both workspaces reclaimed after each child exits; successful and
  invalid-input controls clean up; cancellation returns AbortError and leaves
  no workspace. This regression is added to Quality on Linux.
- 79 initial focused tests and 6,176 full web tests passed (118 DB child skips).
  Two caller lease assertions were subsequently added: 81 final focused tests,
  app/script/test typing and targeted lint pass. Existing actual FFmpeg inherited
  source-lease probe passes on macOS/Node 22. Exact-head CI remains the release gate.
- Native fs-ext tracing already covers API routes. Existing poster lease probe
  now selects the script tsconfig explicitly because poster code imports the
  server-only staging helper; its child receives the same config.

Private evidence: `.audit-evidence/backend-section-06n/` contains the initial
and strengthened 13-case probes, fixture generator, image build instructions,
bundled unchanged-runtime evidence, before/after regression logs and hashes.
The container has no network during testing. All fixture processes are confirmed
exited before fixture removal; `/scratch` cleanup is asserted by the initial
probe. Dedicated containers are ephemeral. Existing databases and local evidence
are preserved.

Next: finish release, then define/enforce a shared source/output reservation
budget and resolve legacy/unpublished metadata policy before closing MEDIA-06/07.
Continue WORKFLOW-02/03/04 afterward.
