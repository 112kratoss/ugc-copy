import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260719035947_generation_model_catalog_control_plane.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

describe('generation model catalog control-plane migration', () => {
  it('creates versioned releases, private operations, and verification history', () => {
    expect(migration).toContain('CREATE TABLE public.generation_models');
    expect(migration).toContain('CREATE TABLE public.generation_model_catalog_releases');
    expect(migration).toContain('CREATE TABLE public.generation_model_catalog_entries');
    expect(migration).toContain('CREATE TABLE public.generation_model_provider_checks');
    expect(migration).toContain('CREATE UNIQUE INDEX generation_model_catalog_one_active_idx');
    expect(migration).toContain('CREATE TRIGGER generation_model_identity_guard_trigger');
  });

  it('publishes, clones, and rolls back releases through service-role-only RPCs', () => {
    for (const signature of [
      'public.publish_generation_model_catalog(uuid, text)',
      'public.clone_generation_model_catalog(text, text, text, text)',
      'public.rollback_generation_model_catalog(text, text)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
  });

  it('keeps all catalog tables inaccessible to browser and mobile roles', () => {
    for (const table of [
      'generation_models',
      'generation_model_catalog_releases',
      'generation_model_catalog_entries',
      'generation_model_provider_checks',
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
    }
  });
});
