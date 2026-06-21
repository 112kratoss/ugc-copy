import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const internalTables = [
  'backend_job_locks',
  'backend_job_runs',
  'backend_rate_limits',
  'generation_completion_jobs',
  'generation_share_events',
  'mobile_push_deliveries',
  'post_resource_bundle_migration_audit',
  'post_share_events',
  'post_source_tools',
];

function readMigration(suffix: string) {
  const migrationName = fs.readdirSync(migrationsDir)
    .find((name) => name.endsWith(suffix));

  expect(migrationName).toBeDefined();
  return fs.readFileSync(path.join(migrationsDir, migrationName!), 'utf8');
}

describe('backend internal table RLS hardening migration', () => {
  it('documents backend-only access with explicit deny policies for public clients', () => {
    const sql = readMigration('_harden_backend_internal_table_rls.sql');

    for (const table of internalTables) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM anon, authenticated`);
      expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO service_role`);
      expect(sql).toContain(`DROP POLICY IF EXISTS "No client access to ${table}" ON public.${table}`);
      expect(sql).toContain(`CREATE POLICY "No client access to ${table}"`);
      expect(sql).toContain(`ON public.${table} FOR ALL TO anon, authenticated`);
      expect(sql).toContain('USING (false)');
      expect(sql).toContain('WITH CHECK (false)');
    }
  });
});
