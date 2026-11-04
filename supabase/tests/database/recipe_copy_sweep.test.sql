-- The recipe-copy-sweep reads (20261103232038_recipe_copy_sweep.sql): which
-- copies of creations' saved inputs and which run-start imports of them nothing
-- names, past the grace period; that each kind of source keeps a path it names,
-- and that generations and canvases are read only for the people in the paths;
-- the walk's cursor and batch; a run start's use of an import; and which removed
-- copy something names again, with what to copy it back from. Only the service
-- role calls them, and neither will take a grace under a day.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(43);

-- ─── Grants and shape ───────────────────────────────────────────────────────
select ok(
  (select bool_and(relrowsecurity) from pg_class
   where oid in ('public.recipe_file_sweep_deletions'::regclass, 'public.recipe_file_sweep_cursors'::regclass, 'public.recipe_import_uses'::regclass)),
  'the ledger, the cursors and the import uses have row level security on'
);
select ok(
  not has_table_privilege('anon', 'public.recipe_file_sweep_deletions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.recipe_file_sweep_deletions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.recipe_import_uses', 'INSERT')
  and not has_table_privilege('authenticated', 'public.recipe_file_sweep_cursors', 'SELECT'),
  'no client reads or writes the sweep''s state'
);
select ok(
  has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'INSERT')
  and has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'UPDATE')
  and has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'DELETE')
  and not has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'TRUNCATE'),
  'the service role records, re-records and forgets removals, and nothing more'
);
select ok(
  not has_table_privilege('service_role', 'public.recipe_import_uses', 'INSERT')
  and not has_table_privilege('service_role', 'public.recipe_import_uses', 'UPDATE')
  and has_table_privilege('service_role', 'public.recipe_import_uses', 'DELETE')
  and not has_table_privilege('service_role', 'public.recipe_file_sweep_cursors', 'UPDATE'),
  'a use is written only by the function, by the database''s clock, and the cursors only by the walk'
);
select throws_ok(
  $$insert into public.recipe_file_sweep_deletions (bucket_id, object_name)
    values ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/upload-1.png')$$,
  '23514', null,
  'the ledger takes only the two folders'
);
select ok(
  (select bool_and(prosecdef and proconfig @> array['search_path=""']) from pg_proc
   where oid in (
     'public.list_recipe_file_sweep_candidates(timestamptz,timestamptz,integer,integer)'::regprocedure,
     'public.list_swept_recipe_copies_named_again(timestamptz,integer)'::regprocedure,
     'public.record_recipe_import_use(uuid,text)'::regprocedure,
     'public.list_recipe_imports_used_since(text[],timestamptz)'::regprocedure
   )),
  'every entry runs as its owner with an empty search path'
);
select ok(
  not has_function_privilege('anon', 'public.list_recipe_file_sweep_candidates(timestamptz,timestamptz,integer,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.list_recipe_file_sweep_candidates(timestamptz,timestamptz,integer,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.list_swept_recipe_copies_named_again(timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.record_recipe_import_use(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.list_recipe_imports_used_since(text[],timestamptz)', 'EXECUTE'),
  'no client calls any of them'
);
select ok(
  has_function_privilege('service_role', 'public.list_recipe_file_sweep_candidates(timestamptz,timestamptz,integer,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.list_swept_recipe_copies_named_again(timestamptz,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.record_recipe_import_use(uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.list_recipe_imports_used_since(text[],timestamptz)', 'EXECUTE'),
  'the service role, which runs the job and the starts, calls them'
);
select ok(
  not has_function_privilege('service_role', 'public.recipe_file_sweep_named(text[])', 'EXECUTE'),
  'the names helper is internal to the reads'
);
select is(
  public.recipe_file_paths_in_text(
    '{"a": "u1/generation-references/g1/00-x.png", "b": "https://h/storage/v1/object/sign/post_resource_files/u1/generation-references/g1/01-y.png?token=t", "c": "generation_inputs/u2/recipe-imports/u1/g1/00-x.png"}'
  ),
  array[
    'generation_inputs/u2/recipe-imports/u1/g1/00-x.png',
    'post_resource_files/u1/generation-references/g1/00-x.png',
    'post_resource_files/u1/generation-references/g1/01-y.png'
  ],
  'reads the paths a text names, bare, bucket-prefixed or in a link'
);

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- A publisher; a buyer who ran today; a buyer who has not; an unrelated user.
insert into auth.users (id, email, aud, role, is_anonymous, created_at, raw_app_meta_data, raw_user_meta_data) values
  ('d7000001-0000-4000-8000-000000000001', 'sweep-publisher@example.invalid', 'authenticated', 'authenticated', false, now() - interval '60 days', '{}', '{}'),
  ('d7000002-0000-4000-8000-000000000002', 'sweep-buyer-active@example.invalid', 'authenticated', 'authenticated', false, now() - interval '60 days', '{}', '{}'),
  ('d7000003-0000-4000-8000-000000000003', 'sweep-buyer-quiet@example.invalid', 'authenticated', 'authenticated', false, now() - interval '60 days', '{}', '{}'),
  ('d7000004-0000-4000-8000-000000000004', 'sweep-unrelated@example.invalid', 'authenticated', 'authenticated', false, now() - interval '60 days', '{}', '{}');

-- The publisher's creation, and another of theirs that names a copy; the quiet
-- buyer's run; an unrelated user's generation naming a copy.
insert into public.generations (id, user_id, status, is_public, created_at, prompt) values
  ('d7100001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001', 'succeeded', true, now() - interval '30 days', 'The creation'),
  ('d7100005-0000-4000-8000-000000000005', 'd7000001-0000-4000-8000-000000000001', 'succeeded', false, now() - interval '20 days',
   'Again from d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/10-reference-in-generation.png'),
  ('d7100003-0000-4000-8000-000000000003', 'd7000003-0000-4000-8000-000000000003', 'succeeded', false, now() - interval '20 days', 'A remix'),
  ('d7100004-0000-4000-8000-000000000004', 'd7000004-0000-4000-8000-000000000004', 'succeeded', false, now() - interval '20 days',
   'Pasted d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/09-reference-unrelated-gen.png');

insert into public.workflow_canvases (id, user_id, title, graph) values
  ('d7500001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001', 'Publisher canvas',
   '{"version":1,"nodes":[{"data":{"storagePath":"d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/11-reference-in-canvas.png"}}],"edges":[]}'),
  ('d7500002-0000-4000-8000-000000000002', 'd7000004-0000-4000-8000-000000000004', 'Unrelated canvas',
   '{"version":1,"nodes":[{"data":{"storagePath":"d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/12-reference-unrelated-canvas.png"}}],"edges":[]}');

insert into public.generation_input_media (id, generation_id, user_id, media_type, role, storage_path, sort_order, metadata) values
  ('d7200001-0000-4000-8000-000000000001', 'd7100001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001',
   'image', 'reference', 'generation_inputs/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/00-reference.png', 0, '{}'),
  -- The quiet buyer's kept input names the copy it came from (recipeFile, bucket-prefixed), the import
  -- it was made from (sourceStoragePath) and another copy inside a signed link (sourceUrl).
  ('d7200003-0000-4000-8000-000000000003', 'd7100003-0000-4000-8000-000000000003', 'd7000003-0000-4000-8000-000000000003',
   'image', 'reference', 'generation_inputs/d7000003-0000-4000-8000-000000000003/d7100003-0000-4000-8000-000000000003/00-reference.png', 0,
   jsonb_build_object(
     'sourceKind', 'recipe-file',
     'recipeFile', 'post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/03-reference-kept-row.png',
     'sourceStoragePath', 'generation_inputs/d7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/named-import.png',
     'sourceUrl', 'https://example.supabase.co/storage/v1/object/sign/post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/04-reference-in-link.png?token=abc'
   ));

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body) values
  ('d7300001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'Sweep recipe post'),
  ('d7300002-0000-4000-8000-000000000002', 'd7000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'Sweep sold recipe post');

-- The recipe once held a copy an edit took out: its first revision still names it.
insert into public.post_resource_bundles (id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, resource_items, prompt_text) values
  ('d7400001-0000-4000-8000-000000000001', 'd7300001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001',
   'free', 'published', 'Sweep recipe', 0,
   '[{"id": "reference-live", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/01-reference-live.png"},
     {"id": "reference-edited-out", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/02-reference-edited-out.png"}]'::jsonb,
   null),
  ('d7400002-0000-4000-8000-000000000002', 'd7300002-0000-4000-8000-000000000002', 'd7000001-0000-4000-8000-000000000001',
   'free', 'published', 'Sweep sold recipe', 0, '[]'::jsonb, 'The sold prompt');
update public.post_resource_bundles
set resource_items = '[{"id": "reference-live", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/01-reference-live.png"}]'::jsonb
where id = 'd7400001-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.post_resource_bundle_revisions where bundle_id = 'd7400001-0000-4000-8000-000000000001'),
  2,
  'fixture: the edit minted a second revision'
);

-- The second recipe is unlocked; its purchase snapshot, supplement and escrow mapping each name a copy.
select is(
  public.unlock_free_post_resource_bundle('d7000003-0000-4000-8000-000000000003', 'd7300002-0000-4000-8000-000000000002', 'free_bundle_sweep_1', 'free_unlock_sweep_1')->>'status',
  'completed',
  'fixture: the quiet buyer unlocks the second recipe'
);
insert into public.post_resource_purchase_media (purchase_id, media_key, storage_path, media_kind, sort_order)
select purchases.id, 'media-1',
  'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/13-reference-in-snapshot.png', 'image', 0
from public.post_resource_bundle_purchases as purchases
where purchases.bundle_id = 'd7400002-0000-4000-8000-000000000002';
insert into public.post_resource_bundle_revision_supplements (revision_id, resource_items)
select revisions.id,
  '[{"id": "supplement", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/15-reference-in-supplement.png"}]'::jsonb
from public.post_resource_bundle_revisions as revisions
where revisions.bundle_id = 'd7400002-0000-4000-8000-000000000002';
insert into public.post_resource_bundle_revision_files (revision_id, source_bucket, source_path, retained_path)
select revisions.id, 'post_resource_files',
  'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/14-reference-in-escrow.png',
  'retained/d7400002/14-reference-in-escrow.png'
from public.post_resource_bundle_revisions as revisions
where revisions.bundle_id = 'd7400002-0000-4000-8000-000000000002';

insert into storage.objects (id, bucket_id, name, created_at) values
  -- Copies, all past the grace period but one.
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-refused-save.png', now() - interval '12 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/01-reference-live.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/02-reference-edited-out.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/03-reference-kept-row.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/04-reference-in-link.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/05-reference-older-refused.png', now() - interval '20 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/06-reference-fresh.png', now() - interval '2 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/09-reference-unrelated-gen.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/10-reference-in-generation.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/11-reference-in-canvas.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/12-reference-unrelated-canvas.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/13-reference-in-snapshot.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/14-reference-in-escrow.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/15-reference-in-supplement.png', now() - interval '10 days'),
  -- Outside the copies' exact folder: never examined.
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/upload-1-photo.png', now() - interval '90 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/deeper/x.png', now() - interval '90 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/.emptyFolderPlaceholder', now() - interval '90 days'),
  (gen_random_uuid(), 'generation_inputs', 'd7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/00-reference.png', now() - interval '90 days'),
  -- Imports: one used today, one used eight hours ago, one nothing names, one a kept input names.
  (gen_random_uuid(), 'generation_inputs', 'd7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/active-import.png', now() - interval '9 days'),
  (gen_random_uuid(), 'generation_inputs', 'd7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/old-use-import.png', now() - interval '9 days'),
  (gen_random_uuid(), 'generation_inputs', 'd7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/stale-import.png', now() - interval '9 days'),
  (gen_random_uuid(), 'generation_inputs', 'd7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/named-import.png', now() - interval '9 days');

insert into public.recipe_import_uses (object_name, buyer_user_id, used_at) values
  ('d7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/old-use-import.png',
   'd7000002-0000-4000-8000-000000000002', now() - interval '8 hours');

-- ─── A run start's use of an import ─────────────────────────────────────────
set local role service_role;
select lives_ok(
  $$select public.record_recipe_import_use('d7000002-0000-4000-8000-000000000002',
      'd7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/active-import.png')$$,
  'a run start records its use of an import'
);
select lives_ok(
  $$select public.record_recipe_import_use('d7000002-0000-4000-8000-000000000002',
      'd7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/active-import.png')$$,
  'and again, in place'
);
select throws_ok(
  $$select public.record_recipe_import_use('d7000003-0000-4000-8000-000000000003',
      'd7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/active-import.png')$$,
  '23514', null,
  'only under the buyer whose folder it is in'
);
select is(
  array(select public.list_recipe_imports_used_since(array[
    'd7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/active-import.png',
    'd7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/old-use-import.png'
  ], now() - interval '1 hour')),
  array['d7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/active-import.png'],
  'answers which of these imports were used since a time'
);
reset role;
select is(
  (select count(*)::integer from public.recipe_import_uses),
  2,
  'one row a use, kept in place'
);

-- ─── The candidates ─────────────────────────────────────────────────────────
set local role service_role;
create temporary table sweep_read on commit drop as
select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '6 hours', 100, 20000) as result;
reset role;

select is(
  (select array_agg(candidate->>'bucketId' || '/' || (candidate->>'name') order by ordinality)
   from sweep_read, jsonb_array_elements(result->'candidates') with ordinality as picked(candidate, ordinality)),
  array[
    'post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-refused-save.png',
    'post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/05-reference-older-refused.png',
    'post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/09-reference-unrelated-gen.png',
    'post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/12-reference-unrelated-canvas.png',
    'generation_inputs/d7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/old-use-import.png',
    'generation_inputs/d7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/stale-import.png'
  ],
  'hands back the unnamed copies, then the imports no start used lately, in name order'
);
select is((select (result->>'examined')::integer from sweep_read), 18, 'examines only the files in the two exact folders');
select is((select (result->>'tooRecent')::integer from sweep_read), 1, 'keeps the copy inside the grace period');
select is((select (result->>'named')::integer from sweep_read), 10, 'keeps what something names');
select is((select (result->>'importsInUse')::integer from sweep_read), 1, 'keeps the import a run start used today');
select is((select (result->>'unnamed')::integer from sweep_read), 6, 'counts every candidate');
select ok((select (result->>'readAt') is not null from sweep_read), 'says when it read, by the database''s clock');

create temporary table kept_names on commit drop as
select unnest(array[
  '01-reference-live.png', '02-reference-edited-out.png', '03-reference-kept-row.png', '04-reference-in-link.png',
  '10-reference-in-generation.png', '11-reference-in-canvas.png', '13-reference-in-snapshot.png',
  '14-reference-in-escrow.png', '15-reference-in-supplement.png'
]) as file;
select is(
  (select count(*)::integer from kept_names
   where exists (
     select 1 from sweep_read, jsonb_array_elements(result->'candidates') as picked(candidate)
     where candidate->>'name' like '%/' || kept_names.file
   )),
  0,
  'never hands back a copy named by the recipe, its older revision, a kept input or a link in one, the publisher''s generation or canvas, a purchase snapshot, an escrow mapping or a supplement'
);
select ok(
  not exists (
    select 1 from sweep_read, jsonb_array_elements(result->'candidates') as picked(candidate)
    where candidate->>'name' like '%upload-1-photo.png' or candidate->>'name' like '%/deeper/%'
       or candidate->>'name' like '%emptyFolderPlaceholder' or candidate->>'name' like '%/00-reference.png'
       or candidate->>'name' like '%named-import.png' or candidate->>'name' like '%active-import.png'
  ),
  'never hands back the creator''s uploads, a deeper file, a placeholder, a kept input, a named import or one in use'
);
select is(
  (select array_agg(after_name order by bucket_id) from public.recipe_file_sweep_cursors),
  array['', ''],
  'a walk that reached the end of each bucket starts over'
);

-- ─── The batch and the walk ─────────────────────────────────────────────────
set local role service_role;
select is(
  public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '6 hours', 1, 20000)->'candidates'->0->>'name',
  'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-refused-save.png',
  'hands back at most the batch it is asked for'
);
reset role;
select is(
  (select array_agg(after_name order by bucket_id) from public.recipe_file_sweep_cursors),
  array['', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-refused-save.png'],
  'and goes on after the last one handed back, leaving a bucket it handed none of where it was'
);
set local role service_role;
select is(
  jsonb_array_length(public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '6 hours', 100, 20000)->'candidates'),
  5,
  'the next read picks up where the batch stopped'
);
select is(
  (public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '6 hours', 100, 1)->>'scanned')::integer,
  2,
  'a read reads at most its page of each bucket'
);
reset role;
select is(
  (select after_name from public.recipe_file_sweep_cursors where bucket_id = 'post_resource_files'),
  'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/.emptyFolderPlaceholder',
  'and moves past it'
);
update public.recipe_file_sweep_cursors set after_name = '';
set local role service_role;
select is(
  jsonb_array_length(public.list_recipe_file_sweep_candidates(now() - interval '15 days', now() - interval '6 hours', 100, 20000)->'candidates'),
  1,
  'a longer grace period keeps more'
);
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '1 hour', now() - interval '6 hours', 100, 100)$$,
  '22023', null,
  'refuses a grace period under a day'
);
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '1 hour', 100, 100)$$,
  '22023', null,
  'refuses an import quiet window under two hours'
);
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '6 hours', 0, 100)$$,
  '22023', null,
  'refuses an empty batch'
);
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '6 hours', 100, 50000)$$,
  '22023', null,
  'refuses a page past twenty thousand objects'
);
reset role;

set local role authenticated;
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '6 hours', 100, 100)$$,
  '42501', null,
  'a signed-in user cannot list anyone''s files'
);
reset role;

-- ─── A removed copy named again ─────────────────────────────────────────────
-- Named again with its saved input; named again with its input gone and a
-- buyer's import of it left; named by nothing; back already; removed long ago.
update public.post_resource_bundles
set resource_items = '[{"id": "reference-d7200001-0000-4000-8000-000000000001", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-d7200001-0000-4000-8000-000000000001.png"},
                       {"id": "reference-gone", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/16-reference-gone-input.png"},
                       {"id": "reference-present", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/03-reference-kept-row.png"}]'::jsonb
where id = 'd7400001-0000-4000-8000-000000000001';
insert into storage.objects (id, bucket_id, name, created_at) values
  (gen_random_uuid(), 'generation_inputs', 'd7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/16-reference-gone-input.png', now() - interval '3 days');
insert into public.recipe_file_sweep_deletions (bucket_id, object_name, deleted_at) values
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-d7200001-0000-4000-8000-000000000001.png', now() - interval '1 day'),
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/16-reference-gone-input.png', now() - interval '1 day'),
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/07-reference-forgotten.png', now() - interval '1 day'),
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/03-reference-kept-row.png', now() - interval '1 day'),
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/01-reference-live.png', now() - interval '30 days');

set local role service_role;
create temporary table named_again on commit drop as
select * from public.list_swept_recipe_copies_named_again(now() - interval '14 days', 100);
reset role;

select is(
  (select array_agg(object_name order by object_name) from named_again),
  array[
    'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-d7200001-0000-4000-8000-000000000001.png',
    'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/16-reference-gone-input.png'
  ],
  'finds the removed copies named again, and not one nothing names, one already back or one removed long ago'
);
select is(
  (select array[input_id::text, input_role, input_sort_order::text, input_storage_path, input_media_type, coalesce(surviving_import, 'none')]
   from named_again where object_name like '%00-reference-d7200001%'),
  array[
    'd7200001-0000-4000-8000-000000000001', 'reference', '0',
    'generation_inputs/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/00-reference.png', 'image', 'none'
  ],
  'with the saved input its file name names, to copy it back from'
);
select is(
  (select array[coalesce(input_id::text, 'none'), surviving_import] from named_again where object_name like '%16-reference-gone-input.png'),
  array['none', 'd7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/16-reference-gone-input.png'],
  'or, its input gone, with a buyer''s import of the same copy'
);
select is(
  (select count(*)::integer from public.recipe_file_sweep_deletions where checked_at is not null),
  4,
  'it marks the removals it looked at, so the next read looks at others first'
);

set local role authenticated;
select throws_ok(
  $$select * from public.list_swept_recipe_copies_named_again(now() - interval '14 days', 100)$$,
  '42501', null,
  'a signed-in user cannot read the ledger through the named-again read'
);
reset role;

select * from finish();
rollback;
