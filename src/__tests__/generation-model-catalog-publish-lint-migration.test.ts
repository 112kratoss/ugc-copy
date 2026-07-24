import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260720155134_fix_generation_model_catalog_publish_lint.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

describe('generation model catalog publish lint migration', () => {
  it('uses the PostgreSQL-supported empty-object check', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.publish_generation_model_catalog(',
    );
    expect(migration).toContain("entry.provider_model_map = '{}'::jsonb");
    expect(migration).not.toContain('jsonb_object_length(');
  });

  it('preserves the invoker and service-role-only RPC boundary', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.publish_generation_model_catalog(uuid, text)',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.publish_generation_model_catalog(uuid, text)',
    );
  });
});
