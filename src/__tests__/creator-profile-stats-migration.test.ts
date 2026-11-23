import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDir = path.join(process.cwd(), 'supabase/migrations');
const migrationFile = '20261014145716_creator_profile_stats_match_grid.sql';

/** The migrations that define the function, oldest first. */
async function definingFiles() {
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const definitions: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    if (sql.includes('FUNCTION public.get_creator_profile_stats(')) definitions.push(file);
  }
  return definitions;
}

/** The newest definition: the grid's rules must hold in whichever migration last re-created it. */
async function readFunctionBody() {
  const newest = (await definingFiles()).at(-1)!;
  const sql = await readFile(path.join(migrationsDir, newest), 'utf8');
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

  it('is defined by the grid fix or a later migration, which the rules above are read from', async () => {
    const definitions = await definingFiles();
    expect(definitions).toContain(migrationFile);
    // 20261123070740 (post view counts) re-created it to add totalViews.
    expect(definitions.at(-1)! >= migrationFile).toBe(true);
  });
});
