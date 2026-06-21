import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_atomic_generation_failure_settlement.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('atomic generation failure settlement migration', () => {
  it('marks failed generations and refunds credits in one database transaction', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.settle_generation_failed');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('UPDATE public.profiles');
    expect(migration).toContain('UPDATE public.generations');
    expect(migration).toContain('WHEN v_refunded THEN true');
    expect(migration).toContain("'already_succeeded'");
  });

  it('keeps the failure settlement RPC private to the backend service role', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.settle_generation_failed(text, timestamp with time zone) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.settle_generation_failed(text, timestamp with time zone) FROM anon');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.settle_generation_failed(text, timestamp with time zone) FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.settle_generation_failed(text, timestamp with time zone) TO service_role');
  });
});
