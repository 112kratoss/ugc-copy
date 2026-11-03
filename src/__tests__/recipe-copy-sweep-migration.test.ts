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
 * sweep from ever removing a file in use.
 */
describe('the recipe copy sweep migration', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const between = (start: string, end: string) => sql.slice(sql.indexOf(start), sql.indexOf(end, sql.indexOf(start)));
  const named = code(between(
    'CREATE FUNCTION public.recipe_file_sweep_named_objects(',
    'ALTER FUNCTION public.recipe_file_sweep_named_objects(',
  ));
  const candidates = code(between(
    'CREATE FUNCTION public.list_recipe_file_sweep_candidates(',
    'ALTER FUNCTION public.list_recipe_file_sweep_candidates(',
  ));
  const namedAgain = code(between(
    'CREATE FUNCTION public.list_swept_recipe_copies_named_again(',
    'ALTER FUNCTION public.list_swept_recipe_copies_named_again(',
  ));

  it('keeps a ledger only the service role reads and writes, of the two folders alone', () => {
    const ledger = code(sql);
    expect(ledger).toContain('CREATE TABLE public.recipe_file_sweep_deletions (');
    expect(ledger).toContain("(bucket_id = 'post_resource_files' AND object_name ~ '^[^/]+/generation-references/[^/]+/[^/]+$')");
    expect(ledger).toContain("(bucket_id = 'generation_inputs' AND object_name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/]+$')");
    expect(ledger).toContain('ALTER TABLE public.recipe_file_sweep_deletions ENABLE ROW LEVEL SECURITY;');
    expect(ledger).toContain('REVOKE ALL PRIVILEGES ON TABLE public.recipe_file_sweep_deletions FROM PUBLIC, anon, authenticated, service_role;');
    expect(ledger).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.recipe_file_sweep_deletions TO service_role;');
  });

  it('reads every recipe, every revision and every kept input for names, whole rows as text', () => {
    for (const source of [
      'to_jsonb(bundles)::text AS body FROM public.post_resource_bundles AS bundles',
      'to_jsonb(revisions)::text FROM public.post_resource_bundle_revisions AS revisions',
      'to_jsonb(supplements)::text FROM public.post_resource_bundle_revision_supplements AS supplements',
      'to_jsonb(files)::text FROM public.post_resource_bundle_revision_files AS files',
      'to_jsonb(purchase_media)::text FROM public.post_resource_purchase_media AS purchase_media',
      'to_jsonb(assets)::text FROM public.marketplace_assets AS assets',
      'to_jsonb(content)::text FROM public.marketplace_asset_content AS content',
      'to_jsonb(inputs)::text FROM public.generation_input_media AS inputs',
      'to_jsonb(generations)::text FROM public.generations AS generations',
      'to_jsonb(canvases)::text FROM public.workflow_canvases AS canvases',
    ]) {
      expect(named).toContain(source);
    }
    // No revision is filtered by purchase or by being the latest: a retired one a buyer holds counts.
    expect(named).not.toMatch(/post_resource_bundle_purchases|is_latest|revision_number/);
  });

  it('refuses a grace period under a day and an import quiet window under an hour', () => {
    expect(candidates).toContain("IF p_created_before IS NULL OR p_created_before > now() - interval '1 day' THEN RAISE EXCEPTION");
    expect(candidates).toContain("IF p_imports_quiet_since IS NULL OR p_imports_quiet_since > now() - interval '1 hour' THEN RAISE EXCEPTION");
    expect(candidates).toContain('IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN RAISE EXCEPTION');
  });

  it('hands back only unnamed files in the exact folders, past the grace period, oldest first, bounded', () => {
    expect(candidates).toContain("(objects.bucket_id = 'post_resource_files' AND objects.name ~ '^[^/]+/generation-references/[^/]+/[^/.][^/]*$')");
    expect(candidates).toContain("(objects.bucket_id = 'generation_inputs' AND objects.name ~ '^[^/]+/recipe-imports/[^/]+/[^/]+/[^/.][^/]*$')");
    expect(candidates).toContain('(layout.created_at IS NULL OR layout.created_at >= p_created_before) AS too_recent');
    expect(candidates).toContain('WHERE NOT eligible.too_recent AND NOT eligible.is_named AND NOT eligible.buyer_active ORDER BY eligible.created_at, eligible.bucket_id, eligible.name LIMIT p_limit');
    expect(candidates).toContain('AND generations.created_at >= p_imports_quiet_since');
  });

  it('runs every read as its owner with an empty search path, and only the service role calls in', () => {
    expect(named).toContain("LANGUAGE sql STABLE SET search_path = ''");
    expect(candidates).toContain("STABLE SECURITY DEFINER SET search_path = ''");
    expect(namedAgain).toContain("STABLE SECURITY DEFINER SET search_path = ''");
    const grants = code(sql);
    expect(grants).toContain('REVOKE ALL ON FUNCTION public.recipe_file_sweep_named_objects(uuid[], uuid[]) FROM PUBLIC, anon, authenticated, service_role;');
    expect(grants).toContain('REVOKE ALL ON FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;');
    expect(grants).toContain('GRANT EXECUTE ON FUNCTION public.list_recipe_file_sweep_candidates(timestamptz, timestamptz, integer) TO service_role;');
    expect(grants).toContain('REVOKE ALL ON FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer) FROM PUBLIC, anon, authenticated;');
    expect(grants).toContain('GRANT EXECUTE ON FUNCTION public.list_swept_recipe_copies_named_again(timestamptz, integer) TO service_role;');
  });

  it('finds a swept copy named again with the saved input its file name names, in its creation', () => {
    expect(namedAgain).toContain("AND NOT EXISTS ( SELECT 1 FROM storage.objects AS objects WHERE objects.bucket_id = 'post_resource_files' AND objects.name = deletions.object_name )");
    expect(namedAgain).toContain('JOIN named ON named.object_name = swept.object_name');
    expect(namedAgain).toContain("AND inputs.generation_id::text = split_part(swept.object_name, '/', 3)");
  });
});
