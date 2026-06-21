import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDirectory)
  .find((name) => name.endsWith('_atomic_media_generation_start.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDirectory, migrationName), 'utf8')
  : '';

describe('atomic media generation start migration', () => {
  it('charges credits and reserves the pending generation row in one database transaction', () => {
    expect(migrationName).toBeDefined();
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.start_generation');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('UPDATE public.profiles');
    expect(migration).toContain('INSERT INTO public.generations');
    expect(migration).toContain("'started'");
    expect(migration).toContain("'already_started'");
    expect(migration).toContain("'in_progress'");
  });

  it('keeps the media generation start RPC private to the backend service role', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text) FROM anon');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text) FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.start_generation(uuid, integer, text, text, text, integer, text, uuid, jsonb, text) TO service_role');
  });
});
