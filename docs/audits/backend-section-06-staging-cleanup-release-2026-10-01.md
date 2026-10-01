# Section 6H release evidence — 2026-10-01

Status: deployed and independently verified; no release work remains pending.

PR [#254](https://github.com/112kratoss/ugc-copy/pull/254), head
`ba0535c8f9be0ef5e84339bf8482f5946eec04bb`, merged as
`bc2fc0976196d996fba2fcca25d399cb60f9049f` at October 1, 02:19:16 UTC
(07:49:16 IST). No mobile store release was active before merge.

PR Quality [36804520935](https://github.com/112kratoss/ugc-copy/actions/runs/36804520935)
and exact-main Quality [36805280456](https://github.com/112kratoss/ugc-copy/actions/runs/36805280456)
passed all four jobs on their first runs: 6,159 web tests, 2,802 mobile tests,
19 browser cases without retry, 1,941 SQL assertions across 90 files, and 119
DB checks (2 credit unlock, 35 cash commerce, 18 payment handlers and 64 generation
recovery). All six staging regression cases ran. The ordinary web run skips
118 database/child-only cases; the DB job independently runs its integration
checks, with the process-worker child entry intentionally skipped by its parent.
Lint, all type checks, performance budgets, build and packaged FFmpeg checks pass.

Standard production release
[36806100925](https://github.com/112kratoss/ugc-copy/actions/runs/36806100925)
succeeded October 1 at 02:33:12 UTC (08:03:12 IST), including staged exact-commit
verification, promotion and protected production health. Independent live checks
confirm SHA `bc2fc097`, feed HTTP 200, admin payout redirect to login HTTP 307 and
unsigned Kie webhook HTTP 401. Remote main matches the live commit.

The runtime fix makes concurrent cleanup callers wait for deletion, permits an
explicit owner retry after deletion fails, and cancels an opened remote source
when temporary-directory allocation fails. Six real-filesystem regressions and
independent permission/HTTP-source probes verify behavior. Local focused suites
passed 102 staging/generation/preview cases and 25 database output/crash cases.
No SQL migration, route/mobile contract, mobile runtime or OTA change is required.

Crash-retained files and disk budgets remain open. A bounded 2 MiB tmpfs filled
after three killed workers retained 600 KiB each; the next attempt failed ENOSPC.
A separate parent-only SIGKILL probe confirmed a surviving child could open and
read the staged file 1.5 seconds later. That generic reader is not an ffmpeg
measurement. These isolated probes establish a local failure mode, not a
production incident or a guarantee about scratch retention after platform
replacement. Safe owner/reader lifetime must precede cross-worker reclamation.

No provider charge, customer balance repair or production fixture was performed.
The preceding Section 6G release evidence is committed in this PR. Private
logs/probes remain in `.audit-evidence/backend-section-06h/`; unrelated local
changes are preserved. The broader backend audit remains open.
