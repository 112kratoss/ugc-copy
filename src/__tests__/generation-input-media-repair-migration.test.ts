import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs
  .readdirSync(migrationsDir)
  .find((file) => file.endsWith('_generation_input_media_repair.sql'));
const migration = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8')
  : '';

describe('generation input media repair migration', () => {
  it('creates service-role-only repair state guarded by RLS', () => {
    expect(migrationFile).toBeTruthy();
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.generation_input_media_repairs');
    expect(migration).toContain('ALTER TABLE public.generation_input_media_repairs ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.generation_input_media_repairs FROM anon, authenticated');
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_input_media_repairs TO service_role',
    );
  });

  it('keys repair state on the generation so a deleted generation takes it along', () => {
    expect(migration).toContain(
      'generation_id uuid PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE',
    );
    expect(migration).toContain('attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)');
  });

  it('selects legacy-only generations: staged references but no durable rows', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.list_generations_missing_durable_input_media');
    expect(migration).toContain("g.workflow_settings::text LIKE '%uploads/%'");
    expect(migration).toContain('NOT EXISTS');
    expect(migration).toContain('FROM public.generation_input_media m');
  });

  it('lets the caller disable the attempt cap', () => {
    // The guard passes NULL: an attempt-exhausted generation still reads its
    // staged files, so it has to stay protected from reclaim forever even
    // though repair has given up on it.
    expect(migration).toContain('p_max_attempts IS NULL OR coalesce(r.attempt_count, 0) < p_max_attempts');
  });

  it('bounds and orders the scan so repair drains oldest-first in batches', () => {
    expect(migration).toContain('g.created_at < p_created_before');
    expect(migration).toContain('ORDER BY g.created_at ASC');
    expect(migration).toContain('LIMIT p_limit');
  });

  it('restricts the selection function to the service role', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.list_generations_missing_durable_input_media');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.list_generations_missing_durable_input_media');
    expect(migration).toContain('TO service_role');
  });

  it('pins search_path on the security-relevant function', () => {
    expect(migration).toContain('SET search_path = public');
  });
});
