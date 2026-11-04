import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = path.join(process.cwd(), 'supabase/migrations/20261103232038_recipe_copy_sweep.sql');

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Drops `--` comments. */
const code = (text: string) => normalize(text.replace(/--[^\n]*/g, ''));

/**
 * The behaviour is asserted by pgTAP (recipe_copy_sweep.test.sql): what is kept,
 * what is handed back, and who may call. This pins the shape that keeps the
 * sweep from ever removing a file in use, and from reading whole tables.
 */
describe('the recipe copy sweep migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const all = code(sql);
  const between = (start: string, end: string) => code(sql.slice(sql.indexOf(start), sql.indexOf(end, sql.indexOf(start))));
  const named = between('CREATE FUNCTION public.recipe_file_sweep_named(', 'ALTER FUNCTION public.recipe_file_sweep_named(');
  const candidates = between(
    'CREATE FUNCTION public.list_recipe_file_sweep_candidates(',
    'ALTER FUNCTION public.list_recipe_file_sweep_candidates(',
  );
  const namedAgain = between(
    'CREATE FUNCTION public.list_swept_recipe_copies_named_again(',
    'ALTER FUNCTION public.list_swept_recipe_copies_named_again(',
  );

  it('keeps its state in service-only tables, of the two folders alone', () => {
    expect(all).toContain("(bucket_id = 'post_resource_files' AND object_name ~ '^[^/]+/generation-references/[^/]+/[^/]+$')");
    expect(all).toContain("(bucket_id = 'generation_inputs' AND object_name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/]+$')");
    for (const table of ['recipe_file_sweep_deletions', 'recipe_file_sweep_cursors', 'recipe_import_uses']) {
      expect(all).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(all).toContain(`REVOKE ALL PRIVILEGES ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role;`);
    }
    expect(all).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recipe_file_sweep_deletions TO service_role;');
    expect(all).toContain('GRANT SELECT ON TABLE public.recipe_file_sweep_cursors TO service_role;');
    // A use is written only through the function, by the database's clock.
    expect(all).toContain('GRANT SELECT, DELETE ON TABLE public.recipe_import_uses TO service_role;');
    expect(all).toContain('ON CONFLICT (object_name) DO UPDATE SET used_at = excluded.used_at;');
  });

  it('indexes the kept inputs that name a recipe file, by the paths they name', () => {
    expect(all).toContain(
      "CREATE INDEX generation_input_media_recipe_file_paths_idx ON public.generation_input_media USING gin (public.recipe_file_paths_in_text(metadata::text)) WHERE strpos(metadata::text, '/generation-references/') > 0 OR strpos(metadata::text, '/recipe-imports/') > 0;",
    );
    expect(all).toContain('CREATE FUNCTION public.recipe_file_paths_in_text(p_text text) RETURNS text[] LANGUAGE sql IMMUTABLE');
  });

  it('reads each source only through keys taken from the paths', () => {
    for (const keyed of [
      'WHERE bundles.owner_user_id IN (SELECT people.id FROM people)',
      'WHERE posts.generation_id IN (SELECT creations.id FROM creations) OR posts.deleted_generation_id IN (SELECT creations.id FROM creations)',
      'WHERE revisions.bundle_id IN (SELECT bundle_ids.id FROM bundle_ids)',
      'WHERE supplements.revision_id IN (SELECT revision_ids.id FROM revision_ids)',
      'WHERE files.revision_id IN (SELECT revision_ids.id FROM revision_ids)',
      'WHERE purchase_media.purchase_id IN (SELECT purchase_ids.id FROM purchase_ids)',
      'WHERE assets.seller_user_id IN (SELECT people.id FROM people)',
      'WHERE inputs.user_id IN (SELECT people.id FROM people)',
      'WHERE inputs.generation_id IN (SELECT creations.id FROM creations)',
      'WHERE generations.id IN (SELECT creations.id FROM creations)',
      'WHERE generations.user_id IN (SELECT people.id FROM people)',
      'WHERE canvases.user_id IN (SELECT people.id FROM people)',
      "AND public.recipe_file_paths_in_text(inputs.metadata::text) && (SELECT coalesce(array_agg(wanted.path), '{}'::text[]) FROM wanted)",
    ]) {
      expect(named).toContain(keyed);
    }
    // No revision is filtered by purchase or by being the latest: a retired one a buyer holds counts.
    expect(named).not.toMatch(/is_latest|revision_number/);
  });

  it('walks each bucket a bounded page from its cursor, in index order', () => {
    expect(candidates).toContain(
      "WHERE objects.bucket_id = 'post_resource_files' AND objects.name > v_after_copies ORDER BY objects.name LIMIT p_scan_limit",
    );
    expect(candidates).toContain(
      "WHERE objects.bucket_id = 'generation_inputs' AND objects.name > v_after_imports ORDER BY objects.name LIMIT p_scan_limit",
    );
    expect(candidates).toContain('IF p_scan_limit IS NULL OR p_scan_limit < 1 OR p_scan_limit > 20000 THEN RAISE EXCEPTION');
    expect(candidates).toContain('UPDATE public.recipe_file_sweep_cursors AS cursors');
  });

  it('refuses a grace period under a day and an import quiet window under two hours', () => {
    expect(candidates).toContain("IF p_created_before IS NULL OR p_created_before > now() - interval '1 day' THEN RAISE EXCEPTION");
    expect(candidates).toContain("IF p_imports_quiet_since IS NULL OR p_imports_quiet_since > now() - interval '2 hours' THEN RAISE EXCEPTION");
    expect(candidates).toContain('IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION');
  });

  it('hands back only unnamed, old files no run start used lately, joined to the named set', () => {
    expect(candidates).toContain('WHERE layout.created_at IS NOT NULL AND layout.created_at < p_created_before');
    expect(candidates).toContain('LEFT JOIN named ON named.path = old.path');
    expect(candidates).toContain('WHERE uses.used_at >= p_imports_quiet_since');
    expect(candidates).toContain('WHERE NOT judged.is_named AND NOT judged.is_in_use');
    expect(candidates).toContain('WHERE ranked.position <= p_limit');
  });

  it('runs every read as its owner with an empty search path, and only the service role calls in', () => {
    expect(named).toContain("LANGUAGE sql STABLE SET search_path = ''");
    expect(candidates).toContain("VOLATILE SECURITY DEFINER SET search_path = ''");
    expect(namedAgain).toContain("VOLATILE SECURITY DEFINER SET search_path = ''");
    expect(all).toContain('REVOKE ALL ON FUNCTION public.recipe_file_sweep_named(text[]) FROM PUBLIC, anon, authenticated, service_role;');
    for (const signature of [
      'list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer, integer)',
      'list_swept_recipe_copies_named_again(timestamptz, integer)',
      'record_recipe_import_use(uuid, text)',
      'list_recipe_imports_used_since(text[], timestamptz)',
    ]) {
      expect(all).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
      expect(all).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
  });

  it('looks at a batch of removals at a time, least recently first, with a surviving import to fall back on', () => {
    expect(namedAgain).toContain('ORDER BY deletions.checked_at NULLS FIRST, deletions.deleted_at LIMIT p_limit FOR UPDATE SKIP LOCKED');
    expect(namedAgain).toContain("JOIN named ON named.path = 'post_resource_files/' || missing.object_name");
    expect(namedAgain).toContain("AND inputs.generation_id::text = split_part(missing.object_name, '/', 3)");
    expect(namedAgain).toContain('CASE WHEN inputs.id IS NULL THEN ( SELECT objects.name FROM storage.objects AS objects');
  });
});
