# Section 6K — disk pressure and audit closure baseline

Status: bounded local investigation complete; two capacity/recovery obligations
remain open. No runtime change or production release in this batch.
Baseline: `5934bd7dac80d402d4db5e274e2716a60432790a` (deployed Section 6J).
Checkout: `codex/staging-disk-audit-6k` in the existing audit checkout.

## Method

Ran the actual `staging-workspace.ts` and `staged-remote-media.ts` implementations
bundled from this checkout on Linux/Node 24.21.0 with pinned `fs-ext` 2.1.1. A
separate container had a **2,097,152-byte tmpfs**, no network, and read-only probe
inputs. Its native lock dependency was compiled in that image. The remote opener
alone was replaced by the existing bounded in-memory fixture; there was no DNS,
HTTP/provider, Storage upload or FFmpeg invocation in these disk probes. Real
kernel locks, files, streams, subprocesses, inherited descriptors and SIGKILL
were used. Actual FFmpeg inheritance remains supported by Section 6J's separate
probe and CI evidence.

The database catalog was read only from the isolated audit database on port
55322 for the closure inventory. No production write, provider charge, customer
repair, primary-checkout change or unrelated container change was performed.

## Results

| Case | Observation | Closure consequence |
| --- | --- | --- |
| Sequential owner death | Five workers each stage 614,400 bytes and receive SIGKILL. Each subsequent allocation reclaims the preceding dead owner; a final staging operation succeeds and cleans to an empty namespace. | MEDIA-03 passed. The earlier accumulation result is corrected for new published workspaces within the scan window. |
| Active owners exhaust capacity | Three live owners retain 1,843,200 bytes. The next 614,400-byte stage gets ENOSPC. All active bytes remain intact; the failed new workspace is removed. | MEDIA-04 passed for live owners; active data is not sacrificed to make room. |
| Inherited reader under pressure | Parent stages 1,843,200 bytes and gives a reader the lease descriptor, then receives SIGKILL. Reclamation returns zero and another stage gets ENOSPC. Reader bytes remain intact. After terminating the reader, a separate claimant reclaims the workspace and a new stage succeeds. | MEDIA-04 passed for inherited readers. |
| Persistent prefix | 130 real workspaces are allocated while their owner is alive. The first 128 entries in actual `opendir` order are made unpublished by removing only their markers; two later entries contain 921,600 bytes each. After owner SIGKILL, ten sweeps reclaim zero, iteration order remains the same, and a new stage fails ENOSPC. | MEDIA-05 failed: 1,843,200 safely reclaimable bytes remain unreachable under this persistent prefix. |
| Prefix control | Removing only the probe's 128 known empty fixtures allows the unchanged sweeper to reclaim both trailing workspaces; the next stage succeeds. | Confirms scan reachability, rather than a bad lock/marker or inadequate total capacity, causes this reproduction. This fixture cleanup is not a proposed production policy. |
| Concurrent observation | Two processes each observe 2,097,152 bytes available, then cross a barrier to stage 1,228,800 bytes each. One succeeds; one gets ENOSPC. The successful file is intact and both paths finish with an empty namespace. | MEDIA-06 remains an unmet capacity-admission obligation. A free-space observation is not a reservation; no existing production statfs preflight is alleged. |

The persistent-prefix probe deliberately injects missing markers; it does not
claim that 128 actual pre-publication crashes occurred in production. Section 6J
already reproduces individual allocation/publication crash boundaries. This
probe establishes the consequence of accumulated persistent entries using real
Linux directory order, not a mocked sorted listing. It neither proves Vercel
retains scratch across all replacements nor proves a production incident.

The concurrent probe demonstrates capacity oversubscription, not corruption or
incorrect settlement. Current staging cleans failed writes correctly in these
cases. Whether failure is retried/backpressured appropriately at every upstream
caller remains part of MEDIA-06 and generation/workflow recovery coverage.

## Scratch inventory and limits

| Owner | Scratch namespace / input bound | Remaining lifecycle evidence |
| --- | --- | --- |
| `staged-remote-media.ts` / `staging-workspace.ts` | `magicbooklet-staging-v1/item-*`; remote stream limits are image 25 MiB, video 250 MiB, audio 50 MiB | Shared admission, progress beyond the bounded scan and incomplete metadata accumulation |
| `video-poster.ts:createVideoPosterBuffer` | `generation-poster-*`, input Blob staged locally | Whole owner/FFmpeg lifetime through kill and cleanup; helper has no independent size gate |
| `video-poster.ts:createVideoPosterBufferFromFile` | `generation-frame-*`, extracted frame | Writer lifetime through parent death; input lease does not cover this separate output directory |
| `video-rendition.ts:withVideoInputFile` | `feed-rendition-src-*`, input gate 512 MiB | Owner/probe/rendition/teaser lifetime and failure recovery |
| `video-rendition.ts:createVideoRenditionFromFile` | `feed-rendition-*` | Output size is checked after encoding; capture combined source/output footprint and surviving writer |
| `video-rendition.ts:createVideoTeaserFromFile` | `feed-teaser-*` | Duration-limited encode still needs byte/lifetime evidence |

These helper limits are not a shared disk budget. Caller-specific limits may be
smaller; peak usage also includes simultaneous sources/outputs and memory-backed
buffers. No other namespace or legacy file was swept. The scan fix must not rename
or delete an active reader's path, explicitly unlock its shared lease, or infer
ownership from age/name alone.

## Closure planning

Added [completion checklist](backend-audit-completion-checklist.md) with stable
obligation IDs, evidence links and passed/failed/untested/external states. Added
[surface map](backend-audit-surface-map-2026-10-01.json): 162 API routes, 201
service files, 323 public functions, 136 public relations and 12 registered jobs.
All routes have review groups. Seven services outside API route closures were
traced to page callers; eight indirect RPC sites were resolved by reading their
wrappers/constants. The remaining 152 functions without an identified JavaScript
caller may be SQL-internal, triggers, or called from other entrypoints; they are
not presumed unused. MAP-02 tracks that reconciliation. This is a finite initial
closure ledger, not a measured percentage or a claim of exhaustive behavior
mapping.

Next implementation work is **MEDIA-05**: choose and test a reclamation progress
mechanism with bounded work and restart behavior. Increasing the scan limit merely
moves the threshold. A process-local cursor alone does not solve repeated cold
worker restarts. Full enumeration changes the latency bound and needs an explicit
capacity decision. Preserve the evidence and evaluate these tradeoffs before
changing the production cleanup policy. Then address shared admission and other
scratch ownership, followed by workflow execution/recovery from the checklist.

## Reproduction artifacts

Private directory: `.audit-evidence/backend-section-06k/`.

- `Dockerfile`, `image-build.log`: isolated Linux native dependency build.
- `build.cjs`, `runtime.cjs`: bundle of the current staging implementation; fixture
  source is `.audit-evidence/backend-section-06h/media-source.cjs`.
- `disk-probe.cjs`, `disk-results.json`, `disk-stderr.log`: four lifecycle/scan
  cases with real directory-order evidence and control.
- `concurrent-probe.cjs`, `concurrent-results.json`, `concurrent-stderr.log`:
  barrier-controlled capacity observation/write experiment.
- `inventory.cjs`, `reviewed-mapping.cjs`, `inventory-full.json`,
  `local-catalog.json`: inventory construction and reviewed indirect mappings.
- `probe-manifest.json`: source/probe hashes and image identity.

To rerun from this audit checkout, build `runtime.cjs` with `node
.audit-evidence/backend-section-06k/build.cjs`, build the directory's Dockerfile
as `audit-staging-disk-6k:local`, then run each probe with a read-only mount of this
private directory at `/input`, `--network none`, `--tmpfs
/scratch:rw,size=2m,mode=700`, `TMPDIR=/scratch`, and
`NODE_PATH=/probe/node_modules`. Invoke `node /input/disk-probe.cjs` or
`node /input/concurrent-probe.cjs`. Probes assert filesystem type/size and clean
only their isolated fixture root. Containers use `--rm`; the temporary image is
removed after recording evidence.

No application test suite was rerun for these documentation-only changes. Both
actual-filesystem probes passed their stated assertions (including reproducing
the open failure), JSON/checklist links and identifiers were checked, and
`git diff --check` passed. Local release evidence from 6J and unrelated existing
changes remain preserved.
