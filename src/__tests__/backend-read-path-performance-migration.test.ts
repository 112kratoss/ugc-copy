import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.join(
  process.cwd(),
  'supabase/migrations/20260715090000_backend_read_path_performance.sql',
);

describe('backend read path performance migration', () => {
  it('provides bounded service-only showcase and summary reads', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.list_showcase_top_sales_post_ids');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_creator_profile_stats');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_owner_post_bundle_summaries');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.get_owner_post_sales_summary');
    expect(sql).toContain('LIMIT least(greatest(coalesce(p_limit, 25), 1), 101)');
    expect(sql).toContain('WITH visible_posts AS MATERIALIZED');
    expect(sql).toContain('resource_kinds text[]');

    for (const signature of [
      'public.list_showcase_top_sales_post_ids(text, text, integer, integer)',
      'public.get_creator_profile_stats(uuid)',
      'public.get_owner_post_bundle_summaries(uuid[])',
      'public.get_owner_post_sales_summary(uuid)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon, authenticated;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`);
    }
  });

  it('materializes data-free workflow summaries and keeps trigger helpers private', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS library_summary jsonb');
    expect(sql).toContain('CREATE TRIGGER workflow_canvases_refresh_library_summary');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF graph');
    expect(sql).toContain("'node_count', jsonb_array_length(v_nodes)");
    expect(sql).toContain("'connection_count', jsonb_array_length(v_edges)");
    expect(sql).toContain('LIMIT 48');
    expect(sql).toContain('LIMIT 72');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.build_workflow_canvas_library_summary(jsonb) FROM anon, authenticated, service_role;',
    );
  });
});
