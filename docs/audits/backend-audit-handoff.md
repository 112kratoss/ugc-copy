# Backend audit — session handoff

Updated 2026-09-29. Read this first when continuing the section-by-section Magicbooklet backend audit.

## Workspace and authorization

Primary repository: `/Users/athuls/UGC copy/ugc-app`.
Active audit checkout: `/Users/athuls/UGC copy/auth-section-one` (reuse it; preserve uncommitted evidence).
Current branch: `codex/payment-event-identity`, based on exact-main `8db0efbde28ce23414ed8e6e51001a4d1e9ef6d2`. Preserve local evidence.
Read the parent and repository AGENTS.md. The user authorized section-by-section audit, reproduction, fixes, verification, and deployment of completed batches. Production rollback fixtures are authorized. Do not charge providers, alter real customer balances, or run production contention/load tests as incidental probes. No new permission is needed for the already-authorized audit/release workflow. Do not spawn subagents unless newly authorized by applicable instructions.

## Exact checkpoint

Section 5G is deployed and verified. No release is pending.
- PR #242 requires the store transaction ID for mobile receipt settlement. A REST-only purchase ID cannot grant credits; later complete receipts settle once, with matching store refunds. Genuine Apple/Google sandbox receipts remain valid.
- Live build: `8db0efbde28ce23414ed8e6e51001a4d1e9ef6d2`.
- Production release: https://github.com/112kratoss/ugc-copy/actions/runs/36581966542 (success at 2026-09-29 14:24:20 UTC).
- Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36580975495.
- 6,122 web tests; 2,783 mobile tests; 19 browser tests; 1,860 SQL assertions; 43 database integration/concurrency cases passed, including ten receipt identity cases. Four prevention cases failed before the fix and passed afterward.
- Patched verifier accepted all eight real RevenueCat receipts read-only. All eight ledger entries match store IDs, with no REST-only keys, unmatched legacy transactions or source/owner/product binding errors. All observed receipts are sandbox.
- Independent live version/feed/auth-boundary checks passed. Authenticated TEST webhook was not run because its credential was unavailable locally. Do not claim end-to-end provider delivery or that the missing-ID transition was observed live.
- No migration or customer data repair. All 16 schema fingerprint classes unchanged; advisors remain 1 INFO / 37 WARN / 0 ERROR.
- Previous Section 5F reports and release evidence were committed in #242. Its migration `20260929120001_reject_conflicting_mobile_entitlement_restores.sql` maps to production ledger version `20260929090935`; adjustment function digest remains `4de80dd5b34a0e99fa3b3d756a0f8c10`.

## Preserve these local files

Carry the new release evidence in the next appropriate audit PR:
- `docs/audits/backend-section-05-receipt-identity-release-2026-09-29.md`.
- This updated handoff file.
- `.audit-evidence/` contains logs and provider/schema snapshots. Preserve it; do not blindly commit it. Section 5G `ledger-private.json` contains private input and must not be published.
- Existing untracked Section 1 release/follow-up files predate this work and remain untouched.

## Next investigation

Section 5H cash-refund event identity fix is prepared for release. Read
`docs/audits/backend-section-05-cash-event-identity-2026-09-29.md` and
`.audit-evidence/backend-section-05h/`. It reproduces incorrect acknowledgments
for conflicting payment/action/order identities in both cash RPCs. Ten baseline
SQL regressions and one webhook adapter regression failed before the fix; clean
replay passes 1,872 assertions. Production rollback probe: eight incorrect results
before the fix, no residual fixtures. New migration is
`20260929142945_validate_cash_adjustment_event_identity.sql`; production planner
found exactly one pending migration and no ordering violation.

Next investigate shared credit event identity and RevenueCat wrapper propagation,
then mobile marketplace concurrency and reporting double-count prevention. Actual provider-backed
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
