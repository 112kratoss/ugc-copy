-- The recipe-copy-sweep reads (20261103232038_recipe_copy_sweep.sql): which
-- copies of creations' saved inputs and which run-start imports of them nothing
-- names, past the grace period; what is kept and why; and which removed copy a
-- recipe names again, with the saved input it is copied back from. Only the
-- service role calls them, and neither will take a grace under a day.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(29);

-- ─── Grants and shape ───────────────────────────────────────────────────────
select has_table('public', 'recipe_file_sweep_deletions', 'the sweep keeps a ledger of what it removed');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.recipe_file_sweep_deletions'::regclass),
  'the ledger has row level security on'
);
select ok(
  not has_table_privilege('anon', 'public.recipe_file_sweep_deletions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.recipe_file_sweep_deletions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.recipe_file_sweep_deletions', 'INSERT'),
  'no client reads or writes the ledger'
);
select ok(
  has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'SELECT')
  and has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'INSERT')
  and has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'UPDATE')
  and has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'DELETE')
  and not has_table_privilege('service_role', 'public.recipe_file_sweep_deletions', 'TRUNCATE'),
  'the service role records, re-records and forgets removals, and nothing more'
);
select throws_ok(
  $$insert into public.recipe_file_sweep_deletions (bucket_id, object_name)
    values ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/upload-1.png')$$,
  '23514', null,
  'the ledger takes only the two folders'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'public.list_recipe_file_sweep_candidates(timestamptz,timestamptz,integer)'::regprocedure),
  'the candidates read runs as its owner with an empty search path'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'public.list_swept_recipe_copies_named_again(timestamptz,integer)'::regprocedure),
  'so does the named-again read'
);
select ok(
  not has_function_privilege('anon', 'public.list_recipe_file_sweep_candidates(timestamptz,timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.list_recipe_file_sweep_candidates(timestamptz,timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_swept_recipe_copies_named_again(timestamptz,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.list_swept_recipe_copies_named_again(timestamptz,integer)', 'EXECUTE'),
  'no client calls either read'
);
select ok(
  has_function_privilege('service_role', 'public.list_recipe_file_sweep_candidates(timestamptz,timestamptz,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.list_swept_recipe_copies_named_again(timestamptz,integer)', 'EXECUTE'),
  'the service role, which runs the job, calls both'
);
select ok(
  not has_function_privilege('service_role', 'public.recipe_file_sweep_named_objects(uuid[],uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.recipe_file_sweep_named_objects(uuid[],uuid[])', 'EXECUTE'),
  'the names helper is internal to the two reads'
);

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- A publisher, a buyer who ran today, and a buyer who has not run lately.
insert into auth.users (id, email, aud, role, is_anonymous, created_at, raw_app_meta_data, raw_user_meta_data) values
  ('d7000001-0000-4000-8000-000000000001', 'sweep-publisher@example.invalid', 'authenticated', 'authenticated', false, now() - interval '60 days', '{}', '{}'),
  ('d7000002-0000-4000-8000-000000000002', 'sweep-buyer-active@example.invalid', 'authenticated', 'authenticated', false, now() - interval '60 days', '{}', '{}'),
  ('d7000003-0000-4000-8000-000000000003', 'sweep-buyer-quiet@example.invalid', 'authenticated', 'authenticated', false, now() - interval '60 days', '{}', '{}');

-- The publisher's creation, with two saved inputs; the active buyer's run of today.
insert into public.generations (id, user_id, status, is_public, created_at) values
  ('d7100001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001', 'succeeded', true, now() - interval '30 days'),
  ('d7100002-0000-4000-8000-000000000002', 'd7000002-0000-4000-8000-000000000002', 'succeeded', false, now() - interval '10 minutes'),
  ('d7100003-0000-4000-8000-000000000003', 'd7000003-0000-4000-8000-000000000003', 'succeeded', false, now() - interval '20 days');

insert into public.generation_input_media (id, generation_id, user_id, media_type, role, storage_path, sort_order, metadata) values
  ('d7200001-0000-4000-8000-000000000001', 'd7100001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001',
   'image', 'reference', 'generation_inputs/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/00-reference.png', 0, '{}'),
  ('d7200002-0000-4000-8000-000000000002', 'd7100001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001',
   'image', 'reference', 'generation_inputs/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/01-reference.png', 1, '{}'),
  -- The quiet buyer's kept input names the copy it came from (recipeFile, bucket-prefixed), an import
  -- it was made from (sourceStoragePath) and another copy inside a signed link (sourceUrl).
  ('d7200003-0000-4000-8000-000000000003', 'd7100003-0000-4000-8000-000000000003', 'd7000003-0000-4000-8000-000000000003',
   'image', 'reference', 'generation_inputs/d7000003-0000-4000-8000-000000000003/d7100003-0000-4000-8000-000000000003/00-reference.png', 0,
   jsonb_build_object(
     'sourceKind', 'recipe_file',
     'recipeFile', 'post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/03-reference-kept-row.png',
     'sourceStoragePath', 'generation_inputs/d7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/named-import.png',
     'sourceUrl', 'https://example.supabase.co/storage/v1/object/sign/post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/04-reference-in-link.png?token=abc'
   ));

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body) values
  ('d7300001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'Sweep recipe post');

-- The recipe once held a copy an edit took out: its first revision still names it.
insert into public.post_resource_bundles (id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, resource_items) values
  ('d7400001-0000-4000-8000-000000000001', 'd7300001-0000-4000-8000-000000000001', 'd7000001-0000-4000-8000-000000000001',
   'free', 'published', 'Sweep recipe', 0,
   '[{"id": "reference-live", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/01-reference-live.png"},
     {"id": "reference-edited-out", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/02-reference-edited-out.png"}]'::jsonb);
update public.post_resource_bundles
set resource_items = '[{"id": "reference-live", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/01-reference-live.png"}]'::jsonb
where id = 'd7400001-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.post_resource_bundle_revisions where bundle_id = 'd7400001-0000-4000-8000-000000000001'),
  2,
  'fixture: the edit minted a second revision'
);

insert into storage.objects (id, bucket_id, name, created_at) values
  -- Copies, all past the grace period but one.
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-refused-save.png', now() - interval '12 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/05-reference-older-refused.png', now() - interval '20 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/01-reference-live.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/02-reference-edited-out.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/03-reference-kept-row.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/04-reference-in-link.png', now() - interval '10 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/06-reference-fresh.png', now() - interval '2 days'),
  -- Outside the copies' exact folder: never examined.
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/upload-1-photo.png', now() - interval '90 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/deeper/x.png', now() - interval '90 days'),
  (gen_random_uuid(), 'post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/.emptyFolderPlaceholder', now() - interval '90 days'),
  (gen_random_uuid(), 'generation_inputs', 'd7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/00-reference.png', now() - interval '90 days'),
  -- Imports: of a quiet buyer, unnamed; of a buyer who ran today; one a kept row names.
  (gen_random_uuid(), 'generation_inputs', 'd7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/stale-import.png', now() - interval '9 days'),
  (gen_random_uuid(), 'generation_inputs', 'd7000002-0000-4000-8000-000000000002/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/active-import.png', now() - interval '9 days'),
  (gen_random_uuid(), 'generation_inputs', 'd7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/named-import.png', now() - interval '9 days');

-- ─── The candidates ─────────────────────────────────────────────────────────
set local role service_role;
create temporary table sweep_read on commit drop as
select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '2 hours', 100) as result;
reset role;

select is(
  (select array_agg(candidate->>'bucketId' || '/' || (candidate->>'name') order by ordinality)
   from sweep_read, jsonb_array_elements(result->'candidates') with ordinality as picked(candidate, ordinality)),
  array[
    'post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/05-reference-older-refused.png',
    'post_resource_files/d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-refused-save.png',
    'generation_inputs/d7000003-0000-4000-8000-000000000003/recipe-imports/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/stale-import.png'
  ],
  'hands back the unnamed copies and the quiet buyer''s unnamed import, oldest first'
);
select is((select (result->>'examined')::integer from sweep_read), 10, 'examines only the files in the two exact folders');
select is((select (result->>'tooRecent')::integer from sweep_read), 1, 'keeps the copy inside the grace period');
select is((select (result->>'named')::integer from sweep_read), 5, 'keeps what a recipe, a revision or a kept input names');
select is((select (result->>'importsInUse')::integer from sweep_read), 1, 'keeps the import of a buyer who ran lately');
select is((select (result->>'unnamed')::integer from sweep_read), 3, 'counts every candidate');

select ok(
  not exists (
    select 1 from sweep_read, jsonb_array_elements(result->'candidates') as picked(candidate)
    where candidate->>'name' like any (array['%01-reference-live.png', '%02-reference-edited-out.png', '%03-reference-kept-row.png', '%04-reference-in-link.png'])
  ),
  'never hands back a copy the recipe, its older revision, a kept input or a link in one names'
);
select ok(
  not exists (
    select 1 from sweep_read, jsonb_array_elements(result->'candidates') as picked(candidate)
    where candidate->>'name' like '%upload-1-photo.png' or candidate->>'name' like '%/deeper/%'
       or candidate->>'name' like '%emptyFolderPlaceholder' or candidate->>'name' like '%/00-reference.png'
  ),
  'never hands back the creator''s uploads, a deeper file, a placeholder or a kept input'
);

set local role service_role;
select is(
  jsonb_array_length(public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '2 hours', 1)->'candidates'),
  1,
  'hands back at most the batch it is asked for'
);
select is(
  public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '2 hours', 1)->'candidates'->0->>'name',
  'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/05-reference-older-refused.png',
  'and the oldest first'
);
select is(
  jsonb_array_length(public.list_recipe_file_sweep_candidates(now() - interval '15 days', now() - interval '2 hours', 100)->'candidates'),
  1,
  'a longer grace period keeps more'
);
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '1 hour', now() - interval '2 hours', 100)$$,
  '22023', null,
  'refuses a grace period under a day'
);
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '10 minutes', 100)$$,
  '22023', null,
  'refuses an import quiet window under an hour'
);
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '2 hours', 0)$$,
  '22023', null,
  'refuses an empty batch'
);
reset role;

set local role authenticated;
select throws_ok(
  $$select public.list_recipe_file_sweep_candidates(now() - interval '7 days', now() - interval '2 hours', 100)$$,
  '42501', null,
  'a signed-in user cannot list anyone''s files'
);
reset role;

-- ─── A removed copy named again ─────────────────────────────────────────────
-- A removed copy the recipe names again (its object is gone); a removed copy
-- nothing names; one a save already made again; one removed long ago.
update public.post_resource_bundles
set resource_items = '[{"id": "reference-d7200001-0000-4000-8000-000000000001", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-d7200001-0000-4000-8000-000000000001.png"},
                       {"id": "reference-present", "storagePath": "d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/03-reference-kept-row.png"}]'::jsonb
where id = 'd7400001-0000-4000-8000-000000000001';
insert into public.recipe_file_sweep_deletions (bucket_id, object_name, deleted_at) values
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-d7200001-0000-4000-8000-000000000001.png', now() - interval '1 day'),
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/07-reference-forgotten.png', now() - interval '1 day'),
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/03-reference-kept-row.png', now() - interval '1 day'),
  ('post_resource_files', 'd7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/01-reference-live.png', now() - interval '30 days');

set local role service_role;
create temporary table named_again on commit drop as
select * from public.list_swept_recipe_copies_named_again(now() - interval '7 days', 100);
reset role;

select is(
  (select array_agg(object_name order by object_name) from named_again),
  array['d7000001-0000-4000-8000-000000000001/generation-references/d7100001-0000-4000-8000-000000000001/00-reference-d7200001-0000-4000-8000-000000000001.png'],
  'finds the removed copy a recipe names again, and not one nothing names, one already back or one removed long ago'
);
select is(
  (select array[input_id::text, input_role, input_sort_order::text, input_storage_path, input_media_type] from named_again),
  array[
    'd7200001-0000-4000-8000-000000000001', 'reference', '0',
    'generation_inputs/d7000001-0000-4000-8000-000000000001/d7100001-0000-4000-8000-000000000001/00-reference.png', 'image'
  ],
  'with the saved input its file name names, to copy it back from'
);

set local role authenticated;
select throws_ok(
  $$select * from public.list_swept_recipe_copies_named_again(now() - interval '7 days', 100)$$,
  '42501', null,
  'a signed-in user cannot read the ledger through the named-again read'
);
reset role;

select * from finish();
rollback;
