import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260714200000_atomic_legacy_media_relink.sql',
);

describe('atomic legacy media relink migration', () => {
  it('atomically locks and relinks the verified object, generation, and linked post', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.relink_legacy_generation_media');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql.match(/FOR UPDATE;/g)).toHaveLength(2);
    expect(sql).toContain('FROM storage.objects');
    expect(sql).toContain('FOR SHARE;');
    expect(sql).toContain('UPDATE public.generations');
    expect(sql).toContain('UPDATE public.posts');
    expect(sql).toContain("v_generation.status IS DISTINCT FROM 'succeeded'");
    expect(sql).toContain('v_generation.output_url IS DISTINCT FROM p_expected_output_url');
    expect(sql).toContain("v_media_kind = 'image'");
    expect(sql).toContain('v_storage_size > v_max_bytes');
    expect(sql).toContain('output_url = p_expected_output_url OR output_url IS NULL');
  });

  it('keeps the privileged relink private to the service role', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.relink_legacy_generation_media\(uuid, text, text\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.relink_legacy_generation_media\(uuid, text, text\)\s+TO service_role;/,
    );
  });
});
