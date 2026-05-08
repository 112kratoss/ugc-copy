import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260508143000_generation_input_media.sql'
);

describe('generation input media migration', () => {
  it('creates durable private input media storage and rows', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain("VALUES ('generation_inputs', 'generation_inputs', false)");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.generation_input_media');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS share_input_media_for_remix boolean NOT NULL DEFAULT false');
    expect(migration).toContain('REFERENCES public.generations(id) ON DELETE CASCADE');
  });

  it('keeps input media owner-scoped through table and storage policies', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('Users can insert own generation input media');
    expect(migration).toContain('generations.user_id = auth.uid()');
    expect(migration).toContain('Users can read own generation inputs');
    expect(migration).toContain("bucket_id = 'generation_inputs'");
    expect(migration).toContain('(storage.foldername(name))[1] = auth.uid()::text');
  });
});
