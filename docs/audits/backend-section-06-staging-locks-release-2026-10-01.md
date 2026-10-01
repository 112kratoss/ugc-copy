# Section 6J release evidence — 2026-10-01

Status: deployed and verified; protected production health passed on release attempt 2.

PR [#255](https://github.com/112kratoss/ugc-copy/pull/255), final head
`285b39468f6a98219e6e4d7c1ee38ce6fac9aedb`, merged as
`5934bd7dac80d402d4db5e274e2716a60432790a` on October 1 at 04:31:36 UTC
(10:01:36 IST). No mobile store release was active before merge.

First PR Quality [36809462816](https://github.com/112kratoss/ugc-copy/actions/runs/36809462816)
passed runtime tests, actual FFmpeg, database, mobile and browser checks, then
caught a test-worker mkdtemp overload cast in test typing. The follow-up commit
accepts all wrapper arguments without the narrow overloaded cast. Runtime code
is unchanged from that first CI run.

Final PR Quality [36810222612](https://github.com/112kratoss/ugc-copy/actions/runs/36810222612)
passed all four jobs: 6,173 web tests (118 DB/child-only skips), 2,802 mobile tests,
19 browser cases without retry, 1,941 SQL assertions across 90 files, and 119
DB checks (including 64 generation checks and nine real worker-kill cases).
The actual FFmpeg inherited-lock probe and native packaging check passed on
Ubuntu/Node 24. Lint, all type checks, performance checks and production build
passed. No unchanged failed-job rerun was needed.

Exact-main Quality [36815532624](https://github.com/112kratoss/ugc-copy/actions/runs/36815532624)
passed all four jobs on its first run. Standard production release
[36816387424](https://github.com/112kratoss/ugc-copy/actions/runs/36816387424)
attempt 1 promoted and verified the public live SHA, then failed its final
protected health check because the returned build ID did not match. Independent
checks confirm live `5934bd7d`, feed HTTP 200, admin login redirect 307 and unsigned
webhook 401. The unchanged failed release job passed on attempt 2, completing
October 1 at 04:50:53 UTC (10:20:53 IST), including the staged verification,
public live SHA and protected production health gates. Independent checks repeated
at 10:42:08 UTC (16:12:08 IST) confirm the same live SHA, feed 200, admin login redirect 307 and unsigned
webhook 401. Remote main still matches the released commit. No release work remains
pending. The initial failure is preserved; its cause is not established from the
log, which does not record the actual mismatched ID.

The new workspace lock protects surviving FFmpeg readers after parent death.
Subsequent imports reclaim only marked, unlocked workspaces within a bounded
scan. Explicit cleanup remains retryable. Local proof includes 118 focused cases,
nine real database/process-kill cases, actual FFmpeg inheritance on macOS and
Linux, and Linux dead-owner reclamation with active-owner preservation. Build
checks verify native lock exclusion/release and the binary in route artifacts.

Legacy files, incomplete metadata directories, other preview/rendition scratch
namespaces, disk admission and scan fairness remain separate obligations. No
production incident or scratch persistence after every container replacement is
inferred. No SQL migration, mobile runtime/OTA change, customer repair, provider
charge or production fixture was performed.

Section 6H release and Section 6I investigation records are included in PR #255.
Private evidence remains under `.audit-evidence/backend-section-06j/`, including
`production-release-first.*`, `production-release-final.*` and `release-smoke.json`.
Protected health does not substitute for a synthetic production media/lock test or
resolve the separately tracked operator moderation review. Unrelated
local changes are preserved. The broader backend audit remains open.
