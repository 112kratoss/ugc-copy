import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Database audit, 2026-11-27: the sitemap's creator list is one grouped function instead of a
 * posts read the API cut at 1,000 rows and a profiles read with every id in its URL.
 * supabase/tests/database/sitemap_creators.test.sql and sitemap-creators-database.test.ts prove
 * its rows; this pins the migration's shape.
 */
const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs.readdirSync(migrationsDir).find((file) => file.endsWith('_sitemap_creators_function.sql'));
const migration = migrationFile ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8') : '';
const body = migration.replace(/^\s*--.*$/gm, '');

describe('sitemap creators function', () => {
  it('is a service-role-only SECURITY DEFINER function with a fixed search path', () => {
    expect(migrationFile).toBeTruthy();
    expect(body).toContain('CREATE OR REPLACE FUNCTION public.list_sitemap_creators(p_min_posts integer, p_limit integer)');
    expect(body).toContain('RETURNS TABLE(username text, last_posted_at timestamp with time zone)');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(body).toContain('REVOKE ALL ON FUNCTION public.list_sitemap_creators(integer, integer) FROM PUBLIC, anon, authenticated;');
    expect(body).toContain('GRANT EXECUTE ON FUNCTION public.list_sitemap_creators(integer, integer) TO service_role;');
  });

  it('applies the gates the sitemap code applied', () => {
    expect(body).toContain("p.visibility = 'public'");
    expect(body).toContain("p.review_status = 'visible'");
    expect(body).toContain('p.archived_at IS NULL');
    expect(body).toContain('s.post_count >= greatest(coalesce(p_min_posts, 1), 1)');
    expect(body).toContain("pr.username IS NOT NULL AND btrim(pr.username) <> ''");
    expect(body).toContain("pr.display_name IS NOT NULL AND btrim(pr.display_name) <> ''");
    expect(body).toContain('ORDER BY s.last_posted_at DESC, pr.username');
  });
});
