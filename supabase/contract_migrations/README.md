# Deferred contract migrations

SQL in this directory is deliberately excluded from Supabase CLI replay and
the production migration runner. It represents destructive or compatibility-
ending release stages whose telemetry gate has not yet been satisfied.

To promote a contract migration:

1. Verify every gate documented at the top of the SQL file.
2. Copy, rather than move, the SQL into `supabase/migrations` with a fresh
   14-digit UTC timestamp later than every applied migration.
3. Run migration replay, pgTAP, typechecks, the production build, and the
   security scan against that promoted revision.
4. Deploy it as a dedicated contract release. Keep the source artifact here as
   the reviewable rollout and emergency-rollback record.

Never add this directory to `.github/scripts/apply-supabase-migrations.mjs`.
That script's narrow `supabase/migrations` scope is the safety boundary.
