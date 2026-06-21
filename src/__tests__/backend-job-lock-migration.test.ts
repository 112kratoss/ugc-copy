import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs
  .readdirSync(migrationsDir)
  .find((file) => file.endsWith('_backend_job_locks.sql'));
const migration = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8')
  : '';

describe('backend job lock migration', () => {
  it('creates a private TTL lock table guarded by RLS', () => {
    expect(migrationFile).toBeTruthy();
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.backend_job_locks');
    expect(migration).toContain('locked_until timestamptz NOT NULL');
    expect(migration).toContain('ALTER TABLE public.backend_job_locks ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.backend_job_locks FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.backend_job_locks TO service_role');
  });

  it('only grants the acquire and release RPCs to the service role', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.try_acquire_backend_job_lock');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.release_backend_job_lock');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.try_acquire_backend_job_lock');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.release_backend_job_lock');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.try_acquire_backend_job_lock');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.release_backend_job_lock');
    expect(migration).toContain('TO service_role');
  });

  it('uses lock expiry instead of session advisory locks so it works through pooled RPC calls', () => {
    expect(migration).toContain('ON CONFLICT (name) DO UPDATE');
    expect(migration).toContain('public.backend_job_locks.locked_until <= now()');
    expect(migration).toContain('make_interval(secs => p_ttl_seconds)');
    expect(migration).not.toContain('pg_try_advisory_lock');
  });
});
