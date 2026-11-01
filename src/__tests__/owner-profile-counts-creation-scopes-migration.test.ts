import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261031231029_owner_profile_counts_creation_scopes.sql',
), 'utf8');

/** The `count(*) FILTER (WHERE …)` that names one creations column. */
function creationsCount(column: string) {
  // The body may not run on into the next count, which a lazy match from the first one would.
  const match = migration.match(new RegExp(
    `count\\(\\*\\) FILTER \\(((?:(?!count\\(\\*\\))[\\s\\S])*?)\\)::integer AS ${column}\\b`,
  ));
  if (!match) throw new Error(`no ${column} count in the migration`);
  return match[1].replace(/\s+/g, ' ').trim();
}

describe('owner profile counts: creation scopes migration', () => {
  it('replaces the function in place, keeping how it runs', () => {
    // Same signature and return type, so /api/profile keeps calling it as it is.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.owner_profile_counts(p_user_id uuid)\nRETURNS jsonb');
    expect(migration).toMatch(/LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(migration).not.toMatch(/DROP FUNCTION/i);
  });

  it('counts the Failed scope as the list route pages it: unarchived failed runs, never a template step', () => {
    expect(creationsCount('failed')).toBe(
      "WHERE generations.archived_at IS NULL AND generations.status = 'failed' "
      + 'AND generations.template_run_id IS NULL AND generations.template_run_step_id IS NULL',
    );
  });

  it('counts Active and Archived with the one library rule, apart only in archived_at', () => {
    const libraryRule = "AND generations.status = 'succeeded' AND ( generations.source_unavailable_at IS NOT NULL OR generations.output_url IS NOT NULL )";
    expect(creationsCount('active')).toBe(`WHERE generations.archived_at IS NULL ${libraryRule}`);
    expect(creationsCount('archived')).toBe(`WHERE generations.archived_at IS NOT NULL ${libraryRule}`);
  });

  it('keeps the owner set and the studio rule around all three counts', () => {
    expect(migration).toContain('WHERE profiles.merged_into_user_id = p_user_id');
    expect(migration).toContain('WHERE generations.user_id IN (SELECT owner_ids.id FROM owner_ids)');
    expect(migration).toContain(
      '(generations.template_run_id IS NULL AND generations.template_run_step_id IS NULL)\n        OR generations.studio_visible',
    );
  });

  it('returns the new keys beside the old ones, which keep their meaning', () => {
    expect(migration).toContain("'creations', (SELECT creations.active FROM creations)");
    expect(migration).toContain("'failedCreations', (SELECT creations.failed FROM creations)");
    expect(migration).toContain("'archivedCreations', (SELECT creations.archived FROM creations)");
    expect(migration).toContain("'posts', (SELECT posts.active FROM posts)");
    expect(migration).toContain("'archivedPosts', (SELECT posts.archived FROM posts)");
    expect(migration).toContain("'saved', (SELECT saved.total FROM saved)");
  });

  it('stays the service role\'s alone', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.owner_profile_counts(uuid) FROM PUBLIC;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.owner_profile_counts(uuid) FROM anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.owner_profile_counts(uuid) TO service_role;');
  });
});
