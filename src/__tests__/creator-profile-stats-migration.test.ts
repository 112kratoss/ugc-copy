import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.join(process.cwd(), 'supabase/migrations');
const migrationFile = '20261014145716_creator_profile_stats_match_grid.sql';

async function readFunctionBody() {
  const sql = await readFile(path.join(migrationsDir, migrationFile), 'utf8');
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.get_creator_profile_stats');
  return { sql, body: sql.slice(start, sql.indexOf('$$;', start)) };
}

describe('creator profile stats migration', () => {
  it('counts the posts and the recipes the creator grid shows', async () => {
    const { body } = await readFunctionBody();

    // The grid reads review_status = 'visible'; flagged posts are not in it.
    expect(body).toContain("AND posts.review_status = 'visible'");
    expect(body).not.toContain("<> 'hidden'");
    // A tile carries a recipe only for a published bundle; the old
    // generation-recipe branch counted in-app posts with none.
    expect(body).toContain("count(*) FILTER (WHERE bundles.status = 'published')::integer AS unlocks");
    expect(body).not.toContain('generation_id');
    expect(body).not.toContain('source_kind');
  });

  it('keeps the function backend-only, definer-run and stable', async () => {
    const { sql } = await readFunctionBody();

    expect(sql).toContain('STABLE\nSECURITY DEFINER\nSET search_path = \'\'');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.get_creator_profile_stats(uuid) FROM PUBLIC;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.get_creator_profile_stats(uuid) FROM anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.get_creator_profile_stats(uuid) TO service_role;');
  });

  it('is the newest definition of the function', async () => {
    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    const definitions: string[] = [];
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      if (sql.includes('FUNCTION public.get_creator_profile_stats(')) definitions.push(file);
    }

    expect(definitions.at(-1)).toBe(migrationFile);
  });
});
