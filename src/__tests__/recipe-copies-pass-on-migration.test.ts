import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Remix plan, phase 1b (owner, 2026-11-05: a remix's recipe holds what its run used): each copy a
// remix's recipe passes on records where it came from, and is served only while that file is still
// its holder's. Behaviour is proved in supabase/tests/database/recipe_copies_pass_on.test.sql (and the
// unchanged answers for every other file in recipe_copies_end_with_access.test.sql); this pins the SQL.
const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20261105150428_recipe_copies_pass_on_with_their_source.sql'),
  'utf8',
);
const sql = migration.replace(/--.*$/gm, '');

function functionBody(name: string): string {
  const match = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`));
  expect(match, name).not.toBeNull();
  return match![0];
}

describe('recipe copies pass on with their source migration', () => {
  it('runs in one transaction that waits at most five seconds for a lock', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('records each passed-on copy once, as a copy of a creation’s input standing on another publisher’s', () => {
    expect(sql).toMatch(/CREATE TABLE public\.recipe_copy_sources \(/);
    expect(sql).toContain("copy_path text PRIMARY KEY\n    CHECK (copy_path ~ '^post_resource_files/[^/]+/generation-references/[^/]+/[^/]+$')");
    expect(sql).toContain("CHECK (source_file ~ '^post_resource_files/[^/]+/generation-references/[^/]+/[^/]+$')");
    expect(sql).toContain('holder_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(sql).toContain("CHECK (split_part(copy_path, '/', 2) <> split_part(source_file, '/', 2))");
    expect(sql).toContain('CREATE INDEX recipe_copy_sources_holder_idx ON public.recipe_copy_sources (holder_user_id);');
  });

  it('keeps the records from every client and lets the server only add them', () => {
    expect(sql).toContain('ALTER TABLE public.recipe_copy_sources ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('REVOKE ALL ON TABLE public.recipe_copy_sources FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.recipe_copy_sources FROM service_role;');
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE public.recipe_copy_sources TO service_role;');
  });

  it('holds a copy to the file it came from, for its holder, and closes a chain past sixteen copies', () => {
    const body = functionBody('recipe_copy_source_withheld_at');
    expect(body).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(body).toContain('FROM public.recipe_copy_sources AS sources');
    expect(body).toContain('IF coalesce(p_depth, 0) >= 16 THEN\n    RETURN true;');
    expect(body).toContain('RETURN NOT public.recipe_file_readable_at(v_source.holder_user_id, v_source.source_file, coalesce(p_depth, 0) + 1);');
  });

  it('withholds a copy of a creation removed or archived, by the two marks only, or one whose source is closed', () => {
    const body = functionBody('recipe_copy_withheld_at');
    expect(body).toContain("parts.folder = 'generation-references'");
    expect(body).toContain('creation.archived_at is not null or creation.moderation_removed_at is not null');
    expect(body).toContain('or public.recipe_copy_source_withheld_at(parts.path, p_depth)');
    expect(body).not.toContain('is_public');
  });

  it('reads a recipe file as 20261103232019 did, but for a copy held to where it came from', () => {
    const body = functionBody('recipe_file_readable_at');
    expect(body).toMatch(/SECURITY DEFINER\s+SET search_path = ''/);
    // A seller's own files are theirs, a passed-on copy only while it stands.
    expect(body).toContain('parts.seller = p_viewer_user_id::text\n          and not public.recipe_copy_source_withheld_at(parts.path, p_depth)');
    // Anyone else: not withheld, and a purchase not retracted whose recipe or bought version lists it.
    expect(body).toContain('not public.recipe_copy_withheld_at(parts.path, p_depth)');
    expect(body).toContain('purchase.buyer_user_id = p_viewer_user_id');
    expect(body).toContain('purchase.moderation_retracted_at is null');
    expect(body).toContain('bundle.owner_user_id::text = parts.seller');
    expect(body).toContain('public.post_resource_bundle_revisions revision');
    expect(body).toContain('public.post_resource_bundle_revision_supplements supplement');

    const wrapper = functionBody('recipe_file_readable_by');
    expect(wrapper).toContain('select public.recipe_file_readable_at(p_viewer_user_id, p_path, 0);');
  });

  it('casts a path segment to a uuid only once it reads as one', () => {
    for (const name of ['recipe_copy_withheld_at', 'recipe_file_readable_at']) {
      const body = functionBody(name);
      const casts = body.match(/::uuid/g) ?? [];
      const guarded = body.match(/~\* '\^\[0-9a-f\]\{8\}-[^']+'\s+then split_part\([^)]*\)::uuid/g) ?? [];
      expect(guarded.length, name).toBe(casts.length);
    }
  });

  it('answers the server’s batch of withheld copies as given', () => {
    const body = functionBody('recipe_copies_withheld');
    expect(body).toContain('where public.recipe_copy_withheld_at(requested.path, 0);');
  });

  it('lets only the server ask any of it', () => {
    for (const signature of [
      'recipe_copy_source_withheld_at(text, integer)',
      'recipe_copy_withheld_at(text, integer)',
      'recipe_file_readable_at(uuid, text, integer)',
      'recipe_file_readable_by(uuid, text)',
      'recipe_copies_withheld(text[])',
    ]) {
      expect(sql, signature).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
      expect(sql, signature).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
  });
});
