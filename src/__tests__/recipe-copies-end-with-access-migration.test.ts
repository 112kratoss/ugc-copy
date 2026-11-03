import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Owner, 2026-11-04: a buyer's read of a recipe's files ends with their unlock, a removed or archived
// creation's copies are withheld, and each Seedance asset records the file it runs. Behaviour is
// proved in supabase/tests/database/recipe_copies_end_with_access.test.sql; this pins the SQL.
const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20261103232019_recipe_copies_end_with_access.sql'),
  'utf8',
);
const sql = migration.replace(/--.*$/gm, '');

function functionBody(name: string): string {
  const match = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`));
  expect(match, name).not.toBeNull();
  return match![0];
}

describe('recipe copies end with access migration', () => {
  it('reads a recipe file only through a live purchase whose recipe or bought version lists it', () => {
    const body = functionBody('recipe_file_readable_by');
    expect(body).toMatch(/security definer\s+set search_path = ''/);
    expect(body).toContain('purchase.buyer_user_id = p_viewer_user_id');
    expect(body).toContain('purchase.moderation_retracted_at is null');
    expect(body).toContain('bundle.owner_user_id::text = parts.seller');
    expect(body).toContain('public.post_resource_bundle_revisions revision');
    expect(body).toContain('public.post_resource_bundle_revision_supplements supplement');
    // A seller's own files are always theirs.
    expect(body).toContain('parts.seller = p_viewer_user_id::text');
  });

  it('withholds a copy of a creation its operator removed or its creator archived, by the two marks only', () => {
    const body = functionBody('recipe_file_readable_by');
    expect(body).toContain("parts.folder = 'generation-references'");
    expect(body).toContain('creation.archived_at is not null or creation.moderation_removed_at is not null');
    expect(body).not.toContain('is_public');
  });

  it('casts a path segment to a uuid only once it reads as one', () => {
    for (const name of ['recipe_file_readable_by', 'generation_input_object_readable']) {
      const body = functionBody(name);
      const casts = body.match(/::uuid/g) ?? [];
      const guarded = body.match(/~\* '\^\[0-9a-f\]\{8\}-[^']+'\s+then split_part\([^)]*\)::uuid/g) ?? [];
      expect(guarded.length, name).toBe(casts.length);
    }
  });

  it('keeps the owner-folder read policy and adds the helper, which refuses imports and closed recipe files', () => {
    expect(sql).toMatch(/drop policy if exists "Users can read own generation inputs" on storage\.objects;/);
    expect(sql).toMatch(/create policy "Users can read own generation inputs"\s+on storage\.objects for select to authenticated\s+using \(\s+bucket_id = 'generation_inputs'\s+and \(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text\s+and public\.generation_input_object_readable\(name\)\s+\);/);
    const helper = functionBody('generation_input_object_readable');
    expect(helper).toContain("split_part(p_name, '/', 2) = 'recipe-imports' then false");
    expect(helper).toContain("<> (select auth.uid())::text");
    expect(helper).toContain("held.file = '' or not public.recipe_file_readable_by(kept.user_id, held.file)");
  });

  it('lets only the server ask the predicate, and a signed-in caller run the policy helper', () => {
    for (const signature of [
      'recipe_file_of_source(uuid, text)',
      'held_input_recipe_file(uuid, jsonb)',
      'recipe_file_readable_by(uuid, text)',
      'recipe_files_readable_by(uuid, text[])',
      'generation_input_object_readable(text)',
    ]) {
      expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`);
    }
    expect(sql).toContain('grant execute on function public.recipe_files_readable_by(uuid, text[]) to service_role;');
    expect(sql).toContain('grant execute on function public.generation_input_object_readable(text) to authenticated, service_role;');
    expect(sql).not.toMatch(/grant execute on function public\.recipe_files?_readable_by[^;]*authenticated/);
  });

  it('records Seedance assets in a table clients cannot reach and the server never rewrites', () => {
    expect(sql).toContain('create table public.seedance_prepared_assets (');
    expect(sql).toContain('owner_user_id uuid not null references auth.users(id) on delete cascade');
    expect(sql).toContain('alter table public.seedance_prepared_assets enable row level security;');
    expect(sql).toContain('revoke all on table public.seedance_prepared_assets from public, anon, authenticated;');
    expect(sql).toContain('revoke update, delete, truncate on table public.seedance_prepared_assets from service_role;');
  });

  it('backfills every asset a run recorded, under the first account that ran it, classified by its file', () => {
    expect(sql).toMatch(/insert into public\.seedance_prepared_assets \(asset_id, owner_user_id, source, recipe_file, recorded_from, created_at\)\s+select distinct on \(entry\.asset_id\)/);
    expect(sql).toContain("run.workflow_settings -> 'seedanceAssets' -> 'images'");
    expect(sql).toContain("run.workflow_settings -> 'seedanceAssets' -> 'videos'");
    expect(sql).toContain("run.workflow_settings -> 'seedanceAssets' -> 'audios'");
    expect(sql).toContain('public.recipe_file_of_source(run.user_id, entry.source)');
    expect(sql).toContain('public.held_input_recipe_file(kept.user_id, kept.metadata)');
    expect(sql).toMatch(/order by entry\.asset_id, run\.created_at, run\.id\s+on conflict \(asset_id\) do nothing;/);
  });
});
