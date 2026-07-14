import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260714112000_durable_account_deletion.sql',
), 'utf8');

describe('durable account deletion migration', () => {
  it('persists a retryable deletion stage without cascading it with auth.users', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.account_deletion_jobs');
    expect(migration).not.toContain('user_id uuid PRIMARY KEY REFERENCES auth.users');
    expect(migration).toContain("'storage_deleting'");
    expect(migration).toContain("'auth_deleting'");
    expect(migration).toContain('storage_manifest jsonb NOT NULL');
    expect(migration).toContain('attempt_count integer NOT NULL');
    expect(migration).toContain("WHEN p_status = 'completed' THEN jsonb_build_object");
    expect(migration).toContain('CREATE TRIGGER account_deletion_job_after_auth_delete');
    expect(migration).toContain('AFTER DELETE ON auth.users');
  });

  it('captures non-user-prefixed showcase and template assets before auth cascades', () => {
    expect(migration).toContain('FROM public.generations');
    expect(migration).toContain('FROM public.posts');
    expect(migration).toContain('FROM public.post_media');
    expect(migration).toContain('post_media.preview_storage_path');
    expect(migration).toContain("LIKE 'posts/' || posts.id::text || '/%'");
    expect(migration).toContain("LIKE 'showcase/' || id::text || '/%'");
    expect(migration).toContain('FROM public.templates');
    expect(migration).toContain("'showcase_media_paths'");
    expect(migration).toContain("'template_asset_prefixes'");
    expect(migration).toContain("'template_database_snapshots', 'anonymize'");
  });

  it('keeps deletion orchestration private to the backend service role', () => {
    expect(migration).toContain('ALTER TABLE public.account_deletion_jobs ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.account_deletion_jobs FROM anon, authenticated');
    expect(migration).toContain('CREATE POLICY "No client access to account_deletion_jobs"');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.prepare_account_deletion(uuid) FROM authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.mark_account_deletion_stage(uuid, text, text) TO service_role');
  });
});
