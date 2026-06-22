import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_atomic_generation_success_settlement.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('atomic generation success settlement migration', () => {
  it('settles successful generations without overwriting failed or refunded rows', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.settle_generation_succeeded');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("'already_failed'");
    expect(migration).toContain('coalesce(v_generation.refunded, false)');
    expect(migration).toContain('UPDATE public.generations');
    expect(migration).toContain("status = 'succeeded'");
  });

  it('keeps the success settlement RPC private to the backend service role', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb) FROM anon');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb) FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.settle_generation_succeeded(text, text, timestamp with time zone, text, text, text, integer, text, timestamp with time zone, jsonb) TO service_role');
  });
});
