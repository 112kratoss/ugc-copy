import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_atomic_generation_provider_task_attach.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('atomic generation provider task attach migration', () => {
  it('attaches provider task ids without reviving terminal generations', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.attach_generation_provider_task');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("'already_settled'");
    expect(migration).toContain('coalesce(v_generation.refunded, false)');
    expect(migration).toContain("status = 'processing'");
    expect(migration).toContain('prediction_id = btrim(p_prediction_id)');
  });

  it('keeps the provider task attach RPC private to the backend service role', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM anon');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.attach_generation_provider_task(uuid, text) FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.attach_generation_provider_task(uuid, text) TO service_role');
  });
});
