# Backend audit — session handoff

Updated 2026-09-30 (Asia/Kolkata). Read this first when continuing the section-by-section Magicbooklet backend audit.

## Workspace and authorization

Primary repository: `/Users/athuls/UGC copy/ugc-app`.
Active audit checkout: `/Users/athuls/UGC copy/auth-section-one` (reuse it; preserve uncommitted evidence).
Current checkout: `codex/payout-detached-reporting-5l`, based on main `b04ccb46cfecb042b8215e521e0633bc44b9cdf9`; branch `codex/mobile-lifecycle-reporting-5k` preserves the merged fix. Branch `codex/mobile-adjustment-event-history` preserves the merged fix. Preserve local evidence.
Read the parent and repository AGENTS.md. The user authorized section-by-section audit, reproduction, fixes, verification, and deployment of completed batches. Production rollback fixtures are authorized. Do not charge providers, alter real customer balances, or run production contention/load tests as incidental probes. No new permission is needed for the already-authorized audit/release workflow. Do not spawn subagents unless newly authorized by applicable instructions.

## Exact checkpoint

Section 5L is fixed and verified locally; its release remains pending. See
`docs/audits/backend-section-05-payout-detached-reporting-2026-09-30.md`.
Three service failures and a real browser reproduction confirmed deleted-account
payout rows break mixed creator enrichment. The fix filters live IDs, retains
reconciliation identity, labels deleted creators and removes their dead links.
15 focused tests, app/test typechecks, lint and before/after Chromium checks pass.
No migration or customer repair is required; production payout inventory is empty.
Private evidence: `.audit-evidence/backend-section-05l/`.

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
- `docs/audits/backend-section-05-mobile-lifecycle-reporting-release-2026-09-30.md` (untracked, records successful Section 5K release).
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
restore-repurchase deadlocks and mirrored-order reporting bugs. Section 5L diagnoses the watchdog and fixes detached payout reporting. Finish its
release, then continue the remaining commerce lifecycle/payout cases.
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
