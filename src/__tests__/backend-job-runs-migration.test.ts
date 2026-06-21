import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs
  .readdirSync(migrationsDir)
  .find((file) => file.endsWith('_backend_job_runs.sql'));
const migration = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8')
  : '';

describe('backend job runs migration', () => {
  it('creates a durable private run ledger for backend jobs', () => {
    expect(migrationFile).toBeTruthy();
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.backend_job_runs');
    expect(migration).toContain('job_name text NOT NULL');
    expect(migration).toContain('request_id text NOT NULL');
    expect(migration).toContain('status text NOT NULL DEFAULT');
    expect(migration).toContain("status IN ('started', 'succeeded', 'skipped', 'failed')");
    expect(migration).toContain('summary jsonb');
    expect(migration).toContain('metadata jsonb NOT NULL DEFAULT');
  });

  it('indexes common operational lookups', () => {
    expect(migration).toContain('backend_job_runs_job_started_idx');
    expect(migration).toContain('ON public.backend_job_runs (job_name, started_at DESC)');
    expect(migration).toContain('backend_job_runs_status_started_idx');
    expect(migration).toContain('ON public.backend_job_runs (status, started_at DESC)');
  });

  it('keeps the ledger out of public client access', () => {
    expect(migration).toContain('ALTER TABLE public.backend_job_runs ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.backend_job_runs FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON public.backend_job_runs FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_job_runs TO service_role');
  });
});
