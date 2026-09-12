# Supabase Production Audit

Date: 2026-06-22
Project ref: `ildfmhozpibwiopeavfg`
Scope: linked production project used by the shared web and mobile backend.

## Result

The database-side security baseline is verified. The linked migration history is in parity, every regular public table has RLS enabled, client roles cannot execute public `SECURITY DEFINER` functions, and legacy client table grants were reduced to the privileges required by the application.

## Verified Controls

- Public tables without RLS: `0`.
- Public `SECURITY DEFINER` functions executable by `anon`, `authenticated`, or `PUBLIC`: `0`.
- Forbidden client grants after hardening: `0`.
- `provider_dependency_events` has RLS enabled.
- `anon` and `authenticated` cannot select provider dependency events.
- `service_role` retains the required select, insert, and delete access.
- Public update policies include ownership checks and `WITH CHECK` clauses.
- Public insert policies include `WITH CHECK` clauses.
- Storage policies are authenticated and owner-folder scoped for application buckets.
- No public views or materialized views were found during the audit.

## Applied Migrations

The following local migrations were pushed to the linked production project and appear in both local and remote migration history:

- `20260622043100_workflow_run_catalog_revision.sql`
- `20260622081050_optimize_saved_media_and_resource_dashboard_indexes.sql`
- `20260622105159_provider_dependency_events.sql`
- `20260622111213_harden_client_table_grants.sql`

The grant-hardening migration removes anonymous row mutations and structural table privileges, plus structural privileges from authenticated clients. It preserves anonymous reads and authenticated row DML where RLS policies permit them.

## Advisor Findings

### Open Dashboard Actions

1. Enable Supabase Auth leaked-password protection.
   - Advisor level: warning.
   - Remediation: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
2. Change Auth database connection allocation from a fixed count of 10 to percentage-based allocation before increasing database compute.
   - Advisor level: informational.
   - Remediation: https://supabase.com/docs/guides/deployment/going-into-prod

### Observed, Not Automatically Removed

The performance advisor reports unused indexes. No indexes were dropped during this audit. Several protect recent query shapes, foreign-key access, jobs, moderation, payments, or newly added telemetry and have not had a representative production traffic window. Re-evaluate index usage after sustained traffic and a known statistics window; remove an index only after checking query plans, write overhead, uniqueness/FK requirements, and rollback impact.

## Verification Evidence

- `supabase migration list --linked` showed matching local and remote versions through `20260622111213`.
- Live metadata query returned `forbidden_client_grants: []`.
- Live metadata query returned `public_tables_without_rls: 0`.
- Live metadata query returned `exposed_security_definer_count: 0`.
- Live provider telemetry isolation query returned RLS enabled, no client reads, and service-role operations enabled.
- Supabase security and performance advisors were re-run after the migration push.

## Follow-Up

The database audit is complete. The two dashboard actions remain production-configuration tasks and should be verified again in the pre-deployment checklist.
