import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs
  .readdirSync(migrationsDir)
  .find((file) => file.endsWith('_backend_job_run_retention.sql'));
const migration = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8')
  : '';

describe('backend job run retention migration', () => {
  it('adds an index for retention cleanup by started time', () => {
    expect(migrationFile).toBeTruthy();
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS backend_job_runs_started_idx');
    expect(migration).toContain('ON public.backend_job_runs (started_at)');
  });

  it('creates a bounded service-role prune RPC', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prune_backend_job_runs');
    expect(migration).toContain('p_retention_days integer DEFAULT 45');
    expect(migration).toContain('p_limit integer DEFAULT 500');
    expect(migration).toContain('p_retention_days < 1 OR p_retention_days > 3650');
    expect(migration).toContain('p_limit < 1 OR p_limit > 10000');
    expect(migration).toContain('ORDER BY started_at ASC');
    expect(migration).toContain('LIMIT p_limit');
  });

  it('keeps pruning unavailable to public clients', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.prune_backend_job_runs(integer, integer) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.prune_backend_job_runs(integer, integer) FROM anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.prune_backend_job_runs(integer, integer) TO service_role');
  });
});
