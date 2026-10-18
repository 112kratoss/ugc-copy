---
paths:
  - "**/supabase/**"
  - "**/scripts/db/**"
  - "**/.github/workflows/repair-migration-ledger.yml"
  - "**/.github/workflows/schema-baseline.yml"
---

# Migrations, the ledger and pgTAP

Moved unchanged from `AGENTS.md` on 2026-10-18 so it loads only where it applies; the core file keeps a summary and points here.

- **Migrations**: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`. Capture changes with `supabase db diff --local --schema public,storage,auth -f name`, verify with `db reset --local`. Never edit an applied migration. Workflow: `docs/supabase-local-prod-workflow.md`.
  - **Stamp a migration with `date -u +%Y%m%d%H%M%S`** (or `supabase migration new`), never local time: the stamp is the only ordering key, so one ahead of the UTC clock outranks every honestly stamped migration until that time passes and the release refuses those as out of order. `supabase-migration-future-stamp.test.ts` fails the change that adds one, and the release refuses to apply one.
  - **The CLI cannot reach production from a developer machine** — neither the direct nor the pooler endpoint answers — so `db push --dry-run --linked` and `migration list --linked` (and therefore `npm run db:migrations:check`) do not work against prod. Ask the parity question with `scripts/db/schema-fingerprint.sql` instead: run it on production through the Supabase MCP / Management API and on a clean replay via the **Schema baseline** workflow, then compare digests per object class.
  - Production's ledger is what a **preview branch** replays, not these files, so the two must agree. `repair-migration-ledger.yml` (`report` / `apply` / `verify`) rewrites every `supabase_migrations.schema_migrations` row from its file. Run it only from `main` and only **after** the matching commit is pushed — repairing first makes the next release read the repository's own history as pending. `supabase-migration-ledger-ordering.test.ts` pins that rule.
  - Applying DDL to production outside these files leaves the ledger unable to rebuild the database: `supabase migration repair` records a version and a name with **no statements**, which is what broke branching (audit *Finding C*).
  - New tables are born with the full `service_role` grant set (`arwdDxtm`): an append-only ledger table must explicitly `REVOKE UPDATE, DELETE` in its migration.
  - pgTAP gotchas: a clean replay lacks the default Data API grants long-lived environments carry, so a local `supabase test db` pass can mask grant drift that fails CI; and fixture inserts into `auth.users` must set `created_at` explicitly — code that branches on account age misreads NULL.
