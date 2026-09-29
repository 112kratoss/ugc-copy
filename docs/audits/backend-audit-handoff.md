# Backend audit — session handoff

Updated 2026-09-29. Read this first when continuing the section-by-section Magicbooklet backend audit.

## Workspace and authorization

Primary repository: `/Users/athuls/UGC copy/ugc-app`.
Active audit checkout: `/Users/athuls/UGC copy/auth-section-one` (reuse it; preserve uncommitted evidence).
Current branch: `codex/mobile-receipt-store-identity`; baseline HEAD `3fa79f92fe906b934b0e5d7dfcceeaddfede7259`.
Read the parent and repository AGENTS.md. The user authorized section-by-section audit, reproduction, fixes, verification, and deployment of completed batches. Production rollback fixtures are authorized. Do not charge providers, alter real customer balances, or run production contention/load tests as incidental probes. No new permission is needed for the already-authorized audit/release workflow. Do not spawn subagents unless newly authorized by applicable instructions.

## Exact checkpoint

Section 5F is deployed and verified. No release is pending for this batch.
- PR #240 repaired conflicting mobile marketplace restoration.
- PR #241 corrected the unapplied migration filename ordering without changing SQL.
- Live build verified: `3fa79f92fe906b934b0e5d7dfcceeaddfede7259`.
- Successful production release: https://github.com/112kratoss/ugc-copy/actions/runs/36547282981
- Final exact-main Quality: https://github.com/112kratoss/ugc-copy/actions/runs/36546155229
- 6,122 web tests; 2,783 mobile tests; 19 browser tests; 1,860 SQL assertions; 33 database integration cases passed.
- 26 production rollback SQL assertions and 34 HTTP assertions passed. Cleanup found zero fixtures. Customer data was not repaired or changed.
- Migration file: `supabase/migrations/20260929120001_reject_conflicting_mobile_entitlement_restores.sql`; production API-assigned ledger version `20260929090935`.
- `reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)` digest: `4de80dd5b34a0e99fa3b3d756a0f8c10`.
- Only functions changed in before/after schema fingerprints. Advisors retained 1 INFO / 37 WARN / 0 ERROR.
- Three credit SKUs are configured; no non-credit mobile settlements existed. Marketplace IAP defect is dormant under this catalog. Bundle IAP creation is explicitly prohibited by credit-only policy.

## Preserve these local files

The release evidence is saved but not yet committed; carry it in the next appropriate audit PR:
- Modified `docs/audits/backend-section-05-mobile-entitlement-restores-2026-09-29.md`.
- New `docs/audits/backend-section-05-mobile-entitlement-restores-release-2026-09-29.md`.
- This handoff file.
- `.audit-evidence/` contains local logs and provider/schema snapshots. Preserve it; do not blindly commit it.
- Existing untracked Section 1 release/follow-up files also predate this checkpoint and must be preserved.

## Next investigation

Receipt identity investigation resumed on 2026-09-29. Read `docs/audits/backend-section-05-receipt-identity-2026-09-29.md` and `.audit-evidence/backend-section-05g/receipt-comparison-redacted.json` for the new checkpoint. The original `.audit-evidence/backend-section-05f/receipt-identity-next.md` remains preserved.

All eight production ledger entries (six Apple, two Google; three owners) match live RevenueCat store IDs; none matches a REST-only purchase ID. All eight provider receipts are sandbox. No legacy mobile credit transaction lacks a mobile-ledger counterpart. Local fault injection confirms duplicate grants / unmatched refunds if a REST-only ID later gains a store ID, but the provider transition remains unobserved. The user subsequently authorized the prevention fix: only `store_transaction_id` may key settlement. Missing store IDs reject sync / skip restore, while genuine store sandbox receipts remain valid. The provider transition remains unobserved; do not claim live reproduction.

New local work to preserve: `src/__tests__/mobile-receipt-identity-database.test.ts` (ten passing real-Postgres cases), its Quality database-job wiring, the Section 5G report, and `.audit-evidence/backend-section-05g/`. Post-fix relevant suite: 65 passed; test typecheck and targeted lint passed. The local-only fault probe has 10 characterization cases, not prevention tests. `ledger-private.json` is private local input; do not commit it. Runtime fix is prepared for the standard release workflow. Real paired provider evidence remains an independent certification gap. Other payment investigations below can proceed independently.

`src/lib/mobile-commerce.ts` chooses `store_transaction_id ?? id` as its settlement key. Existing missing-ID tests omit both fields; they do not establish stability when a RevenueCat-only ID later has a store ID. This is an UNVERIFIED gap, not a confirmed production defect. Establish provider contract/receipt evidence and reproduce at the correct layer before fixing. Do not simply remove the fallback without reviewing existing ledger compatibility. Preserve genuine Apple/Google sandbox receipts used by App Review; client-declared sandbox bypass remains disabled in production.

Other remaining payment work: cross-rail event identity conflicts, mobile marketplace concurrency, reporting double-count prevention, and actual provider-backed delivery/purchase/refund scenarios. Fixing a database path does not certify provider behavior.

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
