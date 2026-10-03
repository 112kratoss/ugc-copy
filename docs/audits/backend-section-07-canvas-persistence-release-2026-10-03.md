# Section 7E — canvas persistence release

October 3, 2026. PR #293 merged as
`f1ec34dc7c46ce6f404bb968e2a4c85c308cb85e` at 10:23:37 IST, after mobile store
release 37095865012 completed successfully. No mobile release was active.

PR Quality 37095664257 and exact-main Quality 37098042595 passed all four jobs.
PR evidence: 6,670 web tests (153 skipped), 2,913 mobile, 24 browser, 1,960 SQL
assertions in 91 files and 153 database cases (two child-harness skips).
Standard release 37098645999 passed its first attempt, including staged and
protected live health; completed 05:08:17 UTC / 10:38:17 IST.

The runtime now retries a failed persistence write after an accepted generation
start rather than failing the workflow. Stable request keys reconnect the same
paid task. Seven real SQL cases cover execution, partial refunds, backpressure,
pure reads, rejected writes and committed writes with lost replies.
See `backend-section-07-canvas-persistence-2026-10-03.md` for scope and limits.
A subsequent private callback-order probe also passes processing, successful
and failed provider states arriving before the link retry, preserving one task.
Provider transport and media persistence remain controlled fixtures.

Production later advanced through other PRs. Independent descendant live checks
are recorded in the private `canvas-persistence-release/` directory. Historical
stranded-run repair and broad workflow completion are not certified. Atomic
approval remains in PR #294 and is a separate fix.
