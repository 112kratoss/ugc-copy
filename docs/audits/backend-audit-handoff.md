# Backend audit — session handoff

Updated 2026-09-30 (Asia/Kolkata). Read this first when continuing the section-by-section Magicbooklet backend audit.

## Workspace and authorization

Primary repository: `/Users/athuls/UGC copy/ugc-app`.
Active audit checkout: `/Users/athuls/UGC copy/auth-section-one` (reuse it; preserve uncommitted evidence).
Current checkout: `codex/generation-marker-recovery-6f`, based on main `d5d71fba5f367af836e52454a0a549f79ff87dbd`; prior audit branches remain preserved. Preserve local evidence.
Read the parent and repository AGENTS.md. The user authorized section-by-section audit, reproduction, fixes, verification, and deployment of completed batches. Production rollback fixtures are authorized. Do not charge providers, alter real customer balances, or run production contention/load tests as incidental probes. No new permission is needed for the already-authorized audit/release workflow. Do not spawn subagents unless newly authorized by applicable instructions.

## Exact checkpoint

Section 6F marker-write recovery is locally verified; PR/CI/release remain pending.
Read `docs/audits/backend-section-06-marker-recovery-2026-09-30.md`.
Twelve start and three reaper DB regressions reproduced before implementation;
actual HTTP reproduced refund/ignored callback. The fix retries marker writes,
preserves unconfirmed holds and request keys, and restores missing markers before
expiry refund. Persistent outages use cautious public copy and defer reaper
settlement. All 183 focused web/DB and 120 mobile contract cases pass; app/test/
mobile typing and lint pass. HTTP transient/persistent retests preserve one hold
and one provider call through callback and same-key replay. No migration or OTA.
Private evidence: `.audit-evidence/backend-section-06f/`. Production read-only
counts remain unchanged; no customer repair. Next: finish this release, then
actual worker termination. The preceding live checkpoint follows.

Section 6E merged in PR #251 as `d5d71fba5f367af836e52454a0a549f79ff87dbd`.
PR Quality `36719881177` passed all four jobs first attempt: 6,150 web tests,
2,801 mobile tests, 19 browser tests, 1,941 SQL assertions and 95 DB checks
(40 generation recovery). No mobile store release was active before merge.
Exact-main Quality `36720852933` passed all four jobs on its first attempt.
Standard production release `36721626640` succeeded at 2026-09-30 13:29:34 UTC.
Independent live SHA `d5d71fba`, feed 200, admin redirect 307 and unsigned webhook
401 passed. Protected staged/live health passed in the workflow. Section 6E is
deployed and verified; no release work remains pending. Read
`docs/audits/backend-section-06-start-recovery-release-2026-09-30.md`.
Preserve local release docs for the next audit PR.
A successful HTTP
creation response without a usable task receipt now enters the existing
ambiguous-submission hold rather than refunding and discarding a later callback.
Six failures reproduced against actual local SQL before implementation. Signed
local start/callback HTTP changed from 500/refunded/ignored callback to
409 submission_pending, callback processing, and same-key 200 replay with one
provider call and one hold. Fourteen DB cases include overlapping same-key
starts, template recovery, lost response and early callback orderings. All 136
focused web/DB checks, 133 mobile checks, app/test/mobile typing and lint pass.
Read `docs/audits/backend-section-06-start-recovery-2026-09-30.md`; preserve
`.audit-evidence/backend-section-06e/`. No migration or mobile runtime change.
Production aggregate has seven unmarked refunded starts without tasks, zero
marked ambiguous and zero active taskless rows; no attribution or repair.
Next: ambiguity-marker write failure/lost response, then worker
termination. The following is the preceding deployed checkpoint.

Section 6D is merged in PR #250 as `8a9eda28810066815efafeb5c0feff93dcd48b5f`.
PR Quality `36711122063` passed all four jobs on its first attempt: 6,150 web,
2,800 mobile, 19 browser, 1,941 SQL assertions and 81 DB integration checks
(26 generation recovery). No mobile store release was active before merge.
Exact-main Quality `36712301682` passed all four jobs on its first attempt.
Standard production release `36713364805` succeeded at 2026-09-30 12:16:38 UTC.
Independent live SHA `8a9eda28`, feed 200, admin redirect 307 and unsigned webhook
401 passed; protected staged/live health passed in the release workflow.
Section 6D is deployed and verified. No release work remains pending. Read
`docs/audits/backend-section-06-grace-recovery-release-2026-09-30.md`.
Release docs remain local for the next audit PR; preserve them.
It fixes acknowledged
loss of late-callback reconciliation when the database write fails or returns an
unconfirmed result: the callback now returns 503 until a record or benign no-op
is confirmed. Five failing real-DB cases and an actual signed local HTTP request
reproduced the defect before implementation. All ten new DB cases now pass,
including strict 45-minute selection and both callback/reaper orderings. Signed
HTTP after-fix results are 503/200/200 with one reconciliation and no second
refund. No migration or mobile runtime change. Read
`docs/audits/backend-section-06-grace-recovery-2026-09-30.md` and preserve
`.audit-evidence/backend-section-06d/`. Production read-only aggregate has zero
marked/refunded ambiguous generations and zero reconciliation rows. No repair.
Next: start-route idempotency and lost provider creation response, including
failure to persist the ambiguity marker; then worker crash recovery. Read
`.audit-evidence/backend-section-06d/next-start-recovery.md`. The following is the prior live checkpoint.

Section 6C is deployed and verified. PR #249 merged as
`5009ce0c858bffca7671d3a4c52f51118e6fbf6d` (preceding live build). PR Quality `36706988869`
and exact-main Quality `36708125072` passed all four jobs: 6,150 web tests,
2,800 mobile tests, 19 browser tests, 1,941 SQL assertions and 71 DB integration
checks (16 generation recovery). The initial PR run caught three outdated inline
settlement assertions; `850e2433` updates the actual route-export tests and
service-role boundary guard. No mobile store release was active before merge.
Standard release `36709175421` succeeded at 2026-09-30 11:36:08 UTC; protected
health and independent live SHA/feed 200/admin redirect 307/webhook 401 passed.

Video, Veo and motion polling now queue durable output imports, stay processing
through storage errors, and notify success after import settlement. No migration
or mobile runtime change. Read the finding and release reports:
`docs/audits/backend-section-06-durable-polling-2026-09-30.md` and
`docs/audits/backend-section-06-durable-polling-release-2026-09-30.md`.
Private evidence: `.audit-evidence/backend-section-06c/`. Production inventory:
12 successful video rows, zero external output URLs, no active video rows;
no repair performed. All synthetic local generation fixtures are removed.

Next: ambiguous submission grace expiry and late callback/reaper races using
real local PostgreSQL and actual service selection. Read the remaining obligation
map in `.audit-evidence/backend-section-06c/remaining-generation-obligations.md`.
Preserve local release evidence for the next audit PR. Section 6B evidence was
committed in #249; the preceding checkpoint follows.

Section 6B is deployed and verified. PR #248 merged as `999e09c4d1e14a1e8112148c2f57ea19e70a21a6`.
PR Quality `36675212554` passed all four jobs: 6,150 web tests, 2,786 mobile tests,
19 browser tests, 1,941 SQL assertions and 65 DB integration/concurrency cases.
The first PR run `36674721423` passed runtime tests but caught an overly broad
upload-mock type in the new test; commit `4f9e25c5` fixes its declaration.
No mobile store release was active before merge. Exact-main Quality `36676000337`
passed all four jobs on its first run. Standard production release `36676774311`
succeeded at 2026-09-30 06:12:42 UTC, including exact live SHA and protected health.
Independent verification on resumption found newer live main `3db9a9c7`, containing
6B unchanged plus community-policy changes. Live SHA/feed 200, admin redirect 307
and unauthorized webhook 401 passed. An actual signed local callback
with empty success output prematurely settled the generation and ignored later
valid output. Six real-DB regressions and seven polling regressions reproduced
before implementation. The fix retries incomplete worker results and keeps
image/video/motion status polling processing, with shared mobile contract tests.
After-fix signed HTTP recovery and import-retry checks pass. No migration or
mobile runtime change. Read `docs/audits/backend-section-06-empty-output-recovery-2026-09-30.md`
and `.audit-evidence/backend-section-06b/`. Production inventory: 88 succeeded,
one missing output already marked source-unavailable; no attributed incident or
customer repair. Section 5L/6A evidence is committed in PR #248.




Section 5L merged in PR #247 as `65890e3146309b5e62fac155f72983de4475a7a1`.
PR Quality `36670834114` passed all four jobs: 6,143 web tests, 2,783 mobile tests,
19 browser tests, 1,941 SQL assertions and 55 DB integration/concurrency cases.
No active mobile store release existed before merge. Exact-main Quality
`36671517379` passed all four jobs after an unchanged E2E-only rerun. The first
E2E attempt passed 18/19, with the composer reorder test losing its execution
context during navigation (same previously observed harness failure); attempt 2
passed 19/19. Both logs are preserved. Standard production release `36672523382`
succeeded at 2026-09-30 05:18:19 UTC. Independent live verification confirms
`65890e31`, public feed HTTP 200, and unauthenticated payouts redirecting to admin
login (307). Section 5L is deployed and verified; no release work remains pending.
Release evidence: `docs/audits/backend-section-05-payout-detached-reporting-release-2026-09-30.md`. See
`docs/audits/backend-section-05-payout-detached-reporting-2026-09-30.md`.
Three service failures and a real browser reproduction confirmed deleted-account
payout rows break mixed creator enrichment. The fix filters live IDs, retains
reconciliation identity, labels deleted creators and removes their dead links.
15 focused tests, app/test typechecks, lint and before/after Chromium checks pass.
No migration or customer repair is required; production payout inventory is empty.
Private evidence: `.audit-evidence/backend-section-05l/`.

While release CI runs, Section 6A initial local generation concurrency checks
passed: completion queue duplicate/claim/takeover/retry invariants and 20-way
failure, success and mixed settlement races. No new defect established; all
local fixtures removed. Read `docs/audits/backend-section-06-generation-recovery-2026-09-30.md`
and `.audit-evidence/backend-section-06a/`. Attachment SQL races also passed: task identity is exclusive and attachment
versus start-failure refund stays consistent. Next: cross-layer callback/start
handling and grace expiry, then import/worker crash recovery.

The watchdog's degraded moderation signal was independently reproduced by the
read-only production collectors: one open report is approximately 64 hours old,
exceeding the 24-hour SLO. Costs carry only `UPLOAD_RECLAIM_WITHHELD` warning;
backend health is ok. The report is not identified as an audit fixture and needs
operator review at `/admin/moderation`; it was not dismissed. Local authenticated
ops HTTP remains unavailable, and the incident remains open.

Section 5K is deployed and verified (preceding release).
- PR #246 merged as `a3d8c25b`; an empty retry commit `b04ccb46cfecb042b8215e521e0633bc44b9cdf9` (identical tree) triggered exact-main CI after the original merge had no run for several hours. No workflow gates changed; no mobile store release was active before either main update.
- PR Quality `36620179778` and exact-main Quality `36666493565` passed all four jobs: 6,139 web tests, 2,783 mobile tests, 19 browser tests, 1,941 SQL assertions and 55 DB integration/concurrency cases.
- Standard production release `36667235304` succeeded at 2026-09-30 04:08:48 UTC, including staged and live protected backend-health checks.
- Migration `20260929191934_reject_conflicting_legacy_bundle_restores.sql` maps to production ledger `20260930040503`. Both deployed function digests match clean local replay; only the functions fingerprint changed. Advisors unchanged: 1 INFO / 37 WARN / 0 ERROR, no added/removed findings.
- Sequential production rollback controls passed 20/20 before and after; separate cleanup found zero fixtures. Legacy-bundle and contention reproduction is local/CI only. Production inventory had no noncredit receipts, so no customer repair was needed.
- Independent live build is `b04ccb46`; feed 200, unauthorized webhook 401. Authenticated TEST/provider delivery remains unverified because credentials are unavailable locally.
- Findings: legacy bundle restore ownership, mobile/web restore-versus-repurchase deadlocks and duplicate admin revenue reporting. Read `docs/audits/backend-section-05-mobile-lifecycle-reporting-2026-09-30.md` and its release report. Evidence is `.audit-evidence/backend-section-05k/`.
- Watchdog follow-up is documented in Section 5L above; the overdue moderation case remains an operator action.
- Shared area-level coverage tracker: `docs/audits/backend-audit-coverage.md`; detailed inventory-to-behavior mapping remains pending.

Section 5J is the preceding verified release (historical checkpoint):
- PR #245 merged as `0c473693a270890c334ce6745e706e25a3e35ad3`; deployed main is `041ff8a5cf3280c7438285e6eb4fd33cc615490f` (one empty CI retry commit, identical tree).
- Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36615600319 — all four jobs passed: 6,136 web tests, 2,783 mobile tests, 19 browser tests, 1,922 SQL assertions and 50 database integration/concurrency cases.
- Standard production release: https://github.com/112kratoss/ugc-copy/actions/runs/36616927718 — succeeded 2026-09-29 19:10:56 UTC. Independent live build matches current main; feed 200 and unauthorized webhook 401.
- Migration `20260929163206_retain_mobile_adjustment_event_identity.sql` maps to production ledger `20260929190728`.
- Production rollback checks: 14/14 passed (7/14 baseline); separate cleanup found zero fixture users, receipts, products, credit adjustments and history rows. Deployed function digest matches local replay.
- Schema changes match the new private history table and modified function. Advisors remain 1 INFO / 37 WARN / 0 ERROR grouped lints; only the expected policy-free private-table INFO finding was added, with no new warnings.
- Authenticated TEST webhook was not run because its credential was unavailable locally. Real provider delivery remains unverified.
- GitHub's delayed push triggers recovered without changing workflow gates. No mobile store release was active before either main update. Do not repeat empty retry commits or treat the historical trigger delay as a current blocker.
- Full evidence: `docs/audits/backend-section-05-mobile-event-history-release-2026-09-29.md` and `.audit-evidence/backend-section-05j/`.

Section 5I is the preceding verified release (historical checkpoint):
- PR #244 binds shared credit events to the original transaction and reversal target. Mobile and Razorpay wrappers propagate unresolved results without consuming metadata or binding a payment; RevenueCat returns retryable 503 with durable telemetry.
- Live build: `17e47edc303588abd4fd3ad18b780378e7b2ba1c`.
- Production release: https://github.com/112kratoss/ugc-copy/actions/runs/36590989396 (success at 2026-09-29 15:35:45 UTC).
- Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36589512045 (all four jobs passed).
- PR Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36588396734 (all four jobs passed): 6,135 web tests; 2,783 mobile tests; 19 browser tests; 1,885 SQL assertions; 47 database integration/concurrency cases.
- Production rollback probe: 11/11 checks passed (7/11 baseline). Separate cleanup found zero fixture users, profiles, transactions, receipts, intents or adjustments. All four deployed function digests match clean local replay.
- Only the functions schema fingerprint changed; advisors remain 1 INFO / 37 WARN / 0 ERROR. Production inventory had no RevenueCat adjustment rows and no detected inconsistent credit receipt bindings, so no customer repair was needed.
- Migration `20260929150256_bind_credit_adjustment_events.sql` maps to production ledger version `20260929153307`.
- Independent live SHA/feed/auth-boundary checks passed. Authenticated TEST webhook was not run because its credential was unavailable locally. Do not claim end-to-end provider delivery.
- The preceding Section 5H cash-event release evidence is committed in #244. Its migration maps to production ledger version `20260929145604`. Section 5G store receipt identity remains deployed; genuine sandbox receipts stay supported.
- Merged main also contains the independent Android OTA target-record commit `cdf31199`, preserved unchanged by this audit.

## Preserve these local files

Carry the new release evidence in the next appropriate audit PR:
- Section 5K release evidence is committed in PR #247.
- Section 5L release evidence and Section 6A initial concurrency report are committed in PR #248.
- Section 6B release evidence is committed in PR #249. Preserve Section 6C release evidence and private logs for the next audit batch.
- This handoff, the updated Section 5K finding report and coverage tracker.
- Section 5J release evidence was committed in PR #246; Section 5I evidence in #245.
- `.audit-evidence/` contains logs and provider/schema snapshots. Preserve it; do not blindly commit it. Section 5G `ledger-private.json` contains private input and must not be published.
- Existing untracked Section 1 release/follow-up files predate this work and remain untouched.

## Next investigation

Section 5I release evidence is in
`docs/audits/backend-section-05-credit-event-binding-release-2026-09-29.md` and
`.audit-evidence/backend-section-05i/`. Six SQL regressions, four database-backed
webhook regressions and six adapter regressions reproduced before their fixes.
An initial restore fixture used ignored `UNCANCELLATION`; the corrected
`REFUND_REVERSED` fixture was rerun against the original SQL and failed as expected.
Production probe results are saved before and after deployment.

Section 5J noncredit mobile event history is fixed, deployed and verified through PR #245. Read `docs/audits/backend-section-05-mobile-event-history-2026-09-29.md`
and `.audit-evidence/backend-section-05j/`. Fifteen baseline identity checks failed;
all 1,922 SQL assertions and three new concurrency cases pass. Production rollback
probe reproduced seven incorrect outcomes before the fix; all 14 checks pass after
deployment and no fixtures remain.

Section 5K closed the reproduced legacy restore ownership, mobile/web
restore-repurchase deadlocks and mirrored-order reporting bugs. Section 5L diagnoses the watchdog and fixes detached payout reporting. Its release is complete. Continue the remaining commerce lifecycle/payout gaps
and the Section 6A generation recovery matrix.
Use the coverage tracker to move next into generation/provider recovery. Actual provider-backed
purchase/refund delivery remains a separate gap. Build a single coverage tracker
before claiming an overall percentage.

Read `docs/audits/backend-section-05-receipt-identity-2026-09-29.md` and its release
report for Section 5G. The original Section 5F next-step note and Section 5G fault
probe logs are historical: their unsafe characterization assertions describe the
pre-fix behavior. Current regression tests are in
`src/__tests__/mobile-receipt-identity-database.test.ts` and run in Quality's DB job.
The user authorized the conditional prevention fix after the initial investigation;
the provider field transition remains unobserved. Preserve genuine App Review
sandbox receipts; client-declared sandbox bypass stays disabled in production.

## Overall coverage — not full sign-off

The user was told a rough 35–40% working estimate, not a measured coverage percentage. Section numbers became smaller fix batches and are not a reliable progress denominator. Build a single coverage tracker from route/service/RPC/job inventories before claiming a percentage.

Four original areas have substantial work, with residual gaps: authentication; database ownership/permissions; credits/payments/refunds; marketplace/creator earnings/payouts. Deployed reports live under `docs/audits/backend-section-*`.

Six major areas still need deeper behavioral coverage: generation/providers; workflow/template execution and recovery; media/storage/signing/retention; posts/feeds/moderation/community; jobs/cron/retries/operations; deployment recovery/backups/capacity. Earlier ownership checks cover only parts of these.

Auth follow-ups include disposable-account deletion and provider revocation, mobile Google deep links, JWT rotation, and CAPTCHA rollout compatible with installed clients. Native Apple sign-in, Chrome web auth and admin login/logout were verified in earlier work; do not repeat stale pending claims from the initial report.

## Release and testing rules

1. Fetch main and inspect local work; preserve evidence and unrelated edits.
2. Reproduce bugs before fixing at their actual layer. Use real Postgres for financial state/concurrency; no speculative fixes.
3. Standard `.github/workflows/production-release.yml` only: exact-main Quality, migrations, edge, stage, health, promote, live check. No manual deployment bypass.
4. Before merging main, verify no mobile-store-release run is active.
5. Create migrations with the pinned CLI. Ensure new filenames sort AFTER the latest applied repository migration, even if an earlier file has a future timestamp. #240 failed release on this exact issue. Use `.github/scripts/apply-supabase-migrations.mjs` `planMigrations` against the complete production ledger before release. Management API ledger timestamps can differ; map unique migration names correctly. Never rename/edit an applied migration.
6. Supabase project `ildfmhozpibwiopeavfg`. Read production through Supabase MCP/Management API; direct CLI/pooler connectivity is unavailable. Never print secrets.
7. Production tests use bounded lock/statement timeouts, isolated fixture IDs, explicit service-role calls and ROLLBACK, followed by separate cleanup queries. Local/CI only for contention tests.
8. Keep exact build, function digests, fingerprints and advisor before/after evidence. Do not call inventory coverage behavioral certification.

Local DB: Docker `supabase_db_magicbooklet-auth-section-one`, port 55322. CLI pinned to 2.75.0 on this Mac. `/tmp/magicbooklet-section2-db/supabase/config.toml` uses project_id `magicbooklet-auth-section-one`, ports 5532*, and symlinks migrations/tests into this checkout. Temporary files may disappear between sessions; reconstruct only this isolated config if needed. `open -a Docker` starts Docker if stopped. Do not reset the primary project's DB.

Commands (from active checkout):
- `npx --yes supabase@2.75.0 db reset --local --no-seed --workdir /tmp/magicbooklet-section2-db`
- `npx --yes supabase@2.75.0 test db --local --workdir /tmp/magicbooklet-section2-db`
- Node 24: `npx --yes --package=node@24 node ...`
- Integration DB URL: `postgresql://postgres:postgres@127.0.0.1:55322/postgres` (local fixture DB only).

GitHub run listings sometimes return stale data. Use exact commit check-runs or a specific run ID before inferring no run exists. Final #241 CI passed first attempt. Earlier #240 main E2E failed on a navigation-destroyed composer context and passed the unchanged failed-job rerun; retain that evidence.
