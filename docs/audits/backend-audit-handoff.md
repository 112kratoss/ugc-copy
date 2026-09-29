# Backend audit — session handoff

Updated 2026-09-29. Read this first when continuing the section-by-section Magicbooklet backend audit.

## Workspace and authorization

Primary repository: `/Users/athuls/UGC copy/ugc-app`.
Active audit checkout: `/Users/athuls/UGC copy/auth-section-one` (reuse it; preserve uncommitted evidence).
Current branch: `codex/credit-event-binding`, based on deployed main `8a7672440940730a30d15bc0b3651035d15188d2`. Preserve local evidence.
Read the parent and repository AGENTS.md. The user authorized section-by-section audit, reproduction, fixes, verification, and deployment of completed batches. Production rollback fixtures are authorized. Do not charge providers, alter real customer balances, or run production contention/load tests as incidental probes. No new permission is needed for the already-authorized audit/release workflow. Do not spawn subagents unless newly authorized by applicable instructions.

## Exact checkpoint

Section 5H is deployed and verified. No release is pending.
- PR #243 rejects cash-refund event replays with conflicting payment, action or order identities, and allows correct purchase-kind dispatcher fallthrough. The webhook treats conflicts as unresolved.
- Live build: `8a7672440940730a30d15bc0b3651035d15188d2`.
- Production release: https://github.com/112kratoss/ugc-copy/actions/runs/36586241502 (success at 2026-09-29 14:59:17 UTC).
- Exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36585132391.
- 6,128 web tests; 2,783 mobile tests; 19 browser tests; 1,872 SQL assertions; 43 database integration/concurrency cases passed.
- Production rollback probe: 11/11 checks passed (3/11 baseline); separate cleanup found zero fixtures. Both changed function digests match clean local replay. Only the functions schema fingerprint changed; advisors remain 1 INFO / 37 WARN / 0 ERROR.
- Migration `20260929142945_validate_cash_adjustment_event_identity.sql` maps to production ledger version `20260929145604`.
- Independent live SHA/feed/auth-boundary checks passed. Authenticated TEST webhook was not run because its credential was unavailable locally. Do not claim end-to-end provider delivery.
- Section 5G receipt identity fix and release evidence are committed in #243. All eight observed real RevenueCat receipts were sandbox and matched store IDs. Missing-ID transition remains unobserved; genuine sandbox receipts stay supported.

## Preserve these local files

Carry the new release evidence in the next appropriate audit PR:
- `docs/audits/backend-section-05-cash-event-identity-release-2026-09-29.md`.
- This updated handoff file.
- `.audit-evidence/` contains logs and provider/schema snapshots. Preserve it; do not blindly commit it. Section 5G `ledger-private.json` contains private input and must not be published.
- Existing untracked Section 1 release/follow-up files predate this work and remain untouched.

## Next investigation

Section 5H release evidence is in
`docs/audits/backend-section-05-cash-event-identity-release-2026-09-29.md` and
`.audit-evidence/backend-section-05h/`. Baseline SQL and adapter failures were
reproduced before the fix; production probe results are recorded before and after.

Section 5I shared credit event binding and RevenueCat wrapper propagation are
fixed locally; read `docs/audits/backend-section-05-credit-event-binding-2026-09-29.md`.
Release is pending. Five SQL regressions, four real-database webhook regressions
and six adapter regressions reproduced before their fixes. The production rollback
probe reproduced four incorrect outcomes and left no fixtures.

Next investigate noncredit mobile event binding, then mobile marketplace concurrency
and reporting double-count prevention. Actual provider-backed
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
