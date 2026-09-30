# Section 6C release — durable video and motion polling

Date: 2026-09-30. Status: deployed and independently verified.

- PR: https://github.com/112kratoss/ugc-copy/pull/249
- Final PR head: `850e2433cab279dd6a2920bc6decd841d33e09dc`.
- Merge and live build: `5009ce0c858bffca7671d3a4c52f51118e6fbf6d`.
- PR Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36706988869 — all four jobs passed.
- Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36708125072 — all four jobs passed on its first run.
- Production release: https://github.com/112kratoss/ugc-copy/actions/runs/36709175421 — succeeded 2026-09-30 11:36:08 UTC.

## Validation and release

Quality passed 6,150 web tests, 2,800 mobile tests, 19 browser tests, 1,941 SQL
assertions across 90 files and 71 database integration/concurrency checks.
The latter includes 16 generation-recovery cases. Web lint, all type checks,
build and packaged-runtime verification passed. Mobile compatibility, native
prebuild, production JS export and type checks passed.

The initial PR run `36706243604` passed database, browser and mobile jobs but
failed three old web assertions that required immediate inline settlement.
Commit `850e2433` updates the actual route-export tests and privileged-client
guard to require the service-role import queue, processing contract, and no
inline download or success settlement. Their 38 local checks passed; the fresh
full PR run then passed. No gate was bypassed or unchanged rerun needed.

No mobile store release was active immediately before merge. The standard
workflow staged, health-checked and promoted this exact main build, then passed
protected production health. Independent probes confirmed live SHA, public feed
HTTP 200, unauthenticated admin payouts redirect 307, and unsigned Kie webhook
rejection 401. No migration, mobile binary/OTA or customer repair was required.

## Evidence and remaining scope

Private logs and smoke output: `.audit-evidence/backend-section-06c/`. The finding
report records failing-before real-database reproductions, successful recovery
tests and their synthetic provider/media/storage/notification boundaries. Actual
provider delivery, storage outages and serverless process death remain unverified.

Read-only production inventory found 12 successful video generations, none with
HTTP(S) output URLs, and no active video rows. No historical repair was performed.
Local recovery fixtures were rolled back; a separate count found zero remaining
audit generation rows. Older untracked Section 1 evidence remains untouched.

Next bounded investigation: ambiguous submission grace expiry and callback/reaper
races across the service and real-database boundaries. The remaining obligation
map is `.audit-evidence/backend-section-06c/remaining-generation-obligations.md`.
The overall audit is not complete. The previously overdue moderation report
still requires operator review; this generation release does not resolve it.
