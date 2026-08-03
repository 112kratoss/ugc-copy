import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs
  .readdirSync(migrationsDir)
  .find((file) => file.endsWith('_media_upload_intents.sql'));
const migration = migrationFile
  ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8')
  : '';

describe('media upload intents migration', () => {
  it('creates a service-role-only table guarded by RLS', () => {
    expect(migrationFile).toBeTruthy();
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.media_upload_intents');
    expect(migration).toContain('ALTER TABLE public.media_upload_intents ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.media_upload_intents FROM anon, authenticated');
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_upload_intents TO service_role',
    );
  });

  it('keys rows on the storage path so a signed upload can only be recorded once', () => {
    expect(migration).toContain('storage_path text NOT NULL UNIQUE');
    expect(migration).toContain('user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
  });

  it('tracks consumption separately from storage clearing', () => {
    // The generation input path consumes bytes without deleting the staging
    // object -- a resubmitted picker selection still needs it -- so collapsing
    // these two columns into one would either leak those objects or break the
    // second generation.
    expect(migration).toContain('consumed_at timestamptz');
    expect(migration).toContain('storage_cleared_at timestamptz');
    expect(migration).toContain('media_upload_intents_consumed_pair_check');
  });

  it('constrains the consumer vocabulary to the four call sites that claim uploads', () => {
    for (const consumer of ['post_publish', 'post_update', 'generation_input', 'generation_restore']) {
      expect(migration).toContain(`'${consumer}'`);
    }
  });

  it('indexes exactly the sweep query', () => {
    expect(migration).toContain('media_upload_intents_uncleared_idx');
    expect(migration).toContain('WHERE storage_cleared_at IS NULL');
  });

  it('constrains kind to the vocabulary the sign route accepts', () => {
    expect(migration).toContain("kind text NOT NULL CHECK (kind IN ('image', 'video', 'audio'))");
  });
});
