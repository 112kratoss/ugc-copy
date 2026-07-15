import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260715101500_public_bundle_summary_hydration.sql',
);

describe('public bundle summary hydration migration', () => {
  it('returns presence for every bundle while masking every draft detail in SQL', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.get_public_post_resource_bundle_summaries',
    );
    expect(sql).toContain('bundles.post_id,');
    expect(sql).toContain('bundles.status');
    expect(sql).toContain(
      'WHERE bundles.post_id = ANY(coalesce(p_post_ids, ARRAY[]::uuid[]))',
    );

    for (const field of [
      'id',
      'title',
      'access_mode',
      'price_usd_cents',
      'preview_text',
      'prompt_text',
      'notes_markdown',
      'workflow_share_url',
      'workflow_snapshot',
      'attachments',
      'allow_remix',
      'resource_sections',
      'resource_items',
      'sales_count',
    ]) {
      expect(sql).toContain(
        `CASE WHEN bundles.status = 'published' THEN bundles.${field} ELSE NULL END AS ${field}`,
      );
    }
  });

  it('keeps the summary RPC backend-only with a pinned search path', async () => {
    const sql = await readFile(migrationPath, 'utf8');
    const signature = 'public.get_public_post_resource_bundle_summaries(uuid[])';

    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path = ''");
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon, authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
  });

  it('replaces full-row public reads with authenticated owner-only access', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain(
      'DROP POLICY IF EXISTS "Post resource bundles are viewable by owner or published"',
    );
    expect(sql).toContain(
      'CREATE POLICY "Owners can view their own post resource bundles"',
    );
    expect(sql).toMatch(
      /ON public\.post_resource_bundles\s+FOR SELECT\s+TO authenticated\s+USING \(\(SELECT auth\.uid\(\)\) = owner_user_id\);/,
    );
    expect(sql).not.toContain("USING (status = 'published' OR auth.uid() = owner_user_id)");
    expect(sql).not.toMatch(/FOR SELECT\s+TO public/);
  });
});
