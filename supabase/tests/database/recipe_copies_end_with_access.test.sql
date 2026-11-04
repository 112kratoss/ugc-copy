-- A buyer's read of a recipe's files ends with their unlock, and a removed or
-- archived creation's copies are withheld (20261103232019): the predicate the
-- server asks, the generation_inputs read policy, and the grants on both and on
-- seedance_prepared_assets.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(41);

-- Seller, buyer, stranger.
insert into auth.users(id, email, aud, role, created_at, is_anonymous, raw_app_meta_data, raw_user_meta_data)
values
  ('ad110001-1000-4000-8000-000000000001', 'copies-seller@example.invalid', 'authenticated', 'authenticated', now(), false, '{}', '{}'),
  ('ad110002-1000-4000-8000-000000000002', 'copies-buyer@example.invalid', 'authenticated', 'authenticated', now(), false, '{}', '{}'),
  ('ad110003-1000-4000-8000-000000000003', 'copies-stranger@example.invalid', 'authenticated', 'authenticated', now(), false, '{}', '{}');

-- The seller's creation, and the buyer's run that used its copy.
insert into public.generations(id, user_id, model, status, is_public)
values
  ('ad110010-1000-4000-8000-000000000001', 'ad110001-1000-4000-8000-000000000001', 'test-model', 'succeeded', true),
  ('ad110011-1000-4000-8000-000000000001', 'ad110002-1000-4000-8000-000000000002', 'test-model', 'succeeded', false);

insert into public.posts(id, user_id, generation_id, title, body, category, post_format, source_kind, visibility, output_url)
values ('ad110020-1000-4000-8000-000000000001', 'ad110001-1000-4000-8000-000000000001', 'ad110010-1000-4000-8000-000000000001',
  'A recipe post', 'Synthetic fixture.', 'image', 'media', 'external', 'public', 'generated_images/copies-fixture.png');
set constraints all immediate;

insert into public.post_resource_bundles(id, post_id, owner_user_id, access_mode, status, title, summary, preview_text, prompt_text, price_usd_cents, resource_items)
values ('ad110030-1000-4000-8000-000000000001', 'ad110020-1000-4000-8000-000000000001', 'ad110001-1000-4000-8000-000000000001',
  'paid', 'published', 'Recipe', 'Summary', 'Preview', 'Prompt', 500,
  '[{"id":"reference-row-1","type":"file","title":"Reference","storagePath":"ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png"}]'::jsonb);
insert into public.post_resource_bundle_orders(id, bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id, amount_subunits, currency, status, quoted_price_usd_cents, quoted_revision_id, quoted_content_fingerprint, quoted_media)
select 'ad110040-1000-4000-8000-000000000001', 'ad110030-1000-4000-8000-000000000001', 'ad110002-1000-4000-8000-000000000002',
  'order_copies_1', 'pay_copies_1', 500, 'USD', 'created', 500, r.id, r.content_fingerprint, '[]'::jsonb
from public.post_resource_bundle_revisions r
where r.bundle_id = 'ad110030-1000-4000-8000-000000000001'
order by r.revision_number desc limit 1;
insert into public.post_resource_bundle_purchases(id, bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency)
values ('ad110050-1000-4000-8000-000000000001', 'ad110030-1000-4000-8000-000000000001', 'ad110002-1000-4000-8000-000000000002',
  'ad110040-1000-4000-8000-000000000001', 500, 500, 'USD');

-- The buyer's kept inputs: one made from the copy, one of their own.
insert into public.generation_input_media(generation_id, user_id, media_type, role, label, storage_path, sort_order, metadata)
values
  ('ad110011-1000-4000-8000-000000000001', 'ad110002-1000-4000-8000-000000000002', 'image', 'reference_image', 'Copy',
   'generation_inputs/ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/00-reference-image.png', 0,
   '{"sourceKind":"recipe-file","recipeFile":"post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png"}'::jsonb),
  ('ad110011-1000-4000-8000-000000000001', 'ad110002-1000-4000-8000-000000000002', 'image', 'reference_image', 'Own',
   'generation_inputs/ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/01-reference-image.png', 1,
   '{"sourceStoragePath":"uploads/ad110002-1000-4000-8000-000000000002/own.png"}'::jsonb);

insert into storage.objects(id, bucket_id, name, version, metadata, created_at)
values
  ('ad110060-1000-4000-8000-000000000001', 'generation_inputs', 'ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/00-reference-image.png', 'v1', '{}'::jsonb, now()),
  ('ad110060-1000-4000-8000-000000000002', 'generation_inputs', 'ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/01-reference-image.png', 'v1', '{}'::jsonb, now()),
  ('ad110060-1000-4000-8000-000000000003', 'generation_inputs', 'ad110002-1000-4000-8000-000000000002/recipe-imports/ad110001-1000-4000-8000-000000000001/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png', 'v1', '{}'::jsonb, now());

-- ─── Which recipe file a held file stands for ───────────────────────────────

select is(
  public.recipe_file_of_source('ad110002-1000-4000-8000-000000000002', 'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png',
  'a seller''s copy is a recipe file to its buyer'
);
select is(
  public.recipe_file_of_source('ad110001-1000-4000-8000-000000000001', 'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  null,
  'a seller''s own copy is their own file'
);
select is(
  public.recipe_file_of_source('ad110002-1000-4000-8000-000000000002', 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/ad110002-1000-4000-8000-000000000002/recipe-imports/ad110001-1000-4000-8000-000000000001/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png?token=abc'),
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png',
  'a signed link to a run start''s import names the copy it was made from'
);
select is(
  public.recipe_file_of_source('ad110002-1000-4000-8000-000000000002', 'uploads/ad110002-1000-4000-8000-000000000002/own.png'),
  null,
  'an upload of the holder''s own is no recipe file'
);
select is(public.held_input_recipe_file('ad110002-1000-4000-8000-000000000002', '{"sourceKind":"recipe-file"}'::jsonb), '',
  'a kept input marked as a recipe file with no file on record stands for an unknown one');
select is(public.held_input_recipe_file('ad110002-1000-4000-8000-000000000002', '{}'::jsonb), null,
  'an unmarked kept input stands for none');

-- ─── May this viewer read this recipe file now ──────────────────────────────

select ok(public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'the buyer reads a copy the recipe they bought lists');
select ok(public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'the predicate reads a path without its bucket too');
select ok(not public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/99-unlisted.png'),
  'the buyer does not read a file the recipe never listed');
select ok(not public.recipe_file_readable_by('ad110003-1000-4000-8000-000000000003',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'a stranger does not read it');
select ok(public.recipe_file_readable_by('ad110001-1000-4000-8000-000000000001',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'the seller reads their own file');
select ok(not public.recipe_file_readable_by(null,
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'nobody signed in reads nothing');
select is(
  public.recipe_files_readable_by('ad110002-1000-4000-8000-000000000002', array[
    'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png',
    'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/99-unlisted.png'
  ]),
  array['post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'],
  'the batch answers the readable paths as given'
);

-- ─── The buyer's own JWT on generation_inputs ───────────────────────────────

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ad110002-1000-4000-8000-000000000002","role":"authenticated"}', true);

select is((select count(*) from storage.objects where bucket_id = 'generation_inputs'
  and name = 'ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/00-reference-image.png'),
  1::bigint, 'while the unlock holds, the buyer reads their kept input made from the copy');
select is((select count(*) from storage.objects where bucket_id = 'generation_inputs'
  and name = 'ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/01-reference-image.png'),
  1::bigint, 'the buyer reads their own kept input');
select is((select count(*) from storage.objects where bucket_id = 'generation_inputs' and name like '%/recipe-imports/%'),
  0::bigint, 'a run start''s import is never read with the buyer''s own JWT');
select ok(not public.generation_input_object_readable('ad110003-1000-4000-8000-000000000003/ad110011-1000-4000-8000-000000000001/00-reference-image.png'),
  'the policy helper answers false for another account''s folder');

reset role;

-- An archive of the seller's creation withholds its copies; un-archiving serves them again.
update public.generations set archived_at = now() where id = 'ad110010-1000-4000-8000-000000000001';
select ok(not public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'an archived creation''s copy is withheld from its buyer');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ad110002-1000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*) from storage.objects where bucket_id = 'generation_inputs'
  and name = 'ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/00-reference-image.png'),
  0::bigint, 'the kept input made from an archived creation''s copy closes to the buyer''s JWT');
reset role;
select ok(public.recipe_file_readable_by('ad110001-1000-4000-8000-000000000001',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'the seller still reads their own copy of an archived creation');
update public.generations set archived_at = null where id = 'ad110010-1000-4000-8000-000000000001';
select ok(public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'un-archiving serves the copy again');
update public.generations set moderation_removed_at = now() where id = 'ad110010-1000-4000-8000-000000000001';
select ok(not public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'an operator''s removal withholds the copy too');
update public.generations set moderation_removed_at = null where id = 'ad110010-1000-4000-8000-000000000001';

-- A retracted purchase reads nothing.
update public.post_resource_bundle_purchases set moderation_retracted_at = now() where id = 'ad110050-1000-4000-8000-000000000001';
select ok(not public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'a retracted purchase reads nothing');
update public.post_resource_bundle_purchases set moderation_retracted_at = null where id = 'ad110050-1000-4000-8000-000000000001';

-- The seller edits the copy out: the version the buyer bought still lists it.
update public.post_resource_bundles set resource_items = '[]'::jsonb where id = 'ad110030-1000-4000-8000-000000000001';
select ok(public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'the version the buyer bought keeps the copy theirs after an edit');

-- A file only the bought version's supplement lists is the buyer's too.
insert into public.post_resource_bundle_revision_supplements(revision_id, resource_items)
select purchase.revision_id,
  '[{"id":"reference-row-2","type":"reference_image","title":"Reference","storagePath":"ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/01-reference-image-row-2.png"}]'::jsonb
from public.post_resource_bundle_purchases purchase
where purchase.id = 'ad110050-1000-4000-8000-000000000001';
select ok(public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/01-reference-image-row-2.png'),
  'the buyer reads a file only the bought version''s supplement lists');
select ok(not public.recipe_file_readable_by('ad110003-1000-4000-8000-000000000003',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/01-reference-image-row-2.png'),
  'a stranger does not read it');

-- The bundle goes (its seller's account is erased) and the bought version stays: still the buyer's.
-- Erasure leaves the purchase and its version with no bundle (ON DELETE SET NULL); a sold bundle is
-- not deleted outside it, so its outcome is set here directly.
update public.post_resource_bundle_purchases set bundle_id = null where id = 'ad110050-1000-4000-8000-000000000001';
select is((select bundle_id from public.post_resource_bundle_purchases where id = 'ad110050-1000-4000-8000-000000000001'), null::uuid,
  'the purchase outlives its bundle');
select ok(public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002', 'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'with the bundle gone, the version the buyer bought keeps the copy theirs');

-- ─── The Seedance asset backfill's classification ───────────────────────────

insert into public.generations(id, user_id, model, status, is_public, created_at, workflow_settings)
values
  ('ad110012-1000-4000-8000-000000000001', 'ad110002-1000-4000-8000-000000000002', 'seedance-2', 'succeeded', false, '2026-11-01T00:00:00Z',
   jsonb_build_object('seedanceAssets', jsonb_build_object(
     'images', jsonb_build_array(
       jsonb_build_object('assetId', 'asset-own-1', 'sourceUrl', 'uploads/ad110002-1000-4000-8000-000000000002/own.png'),
       jsonb_build_object('assetId', 'asset-copy-1', 'sourceUrl', 'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
       jsonb_build_object('assetId', 'asset-import-1', 'sourceUrl',
         'https://project.supabase.co/storage/v1/object/sign/generation_inputs/ad110002-1000-4000-8000-000000000002/recipe-imports/ad110001-1000-4000-8000-000000000001/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png?token=t'),
       jsonb_build_object('assetId', 'not a handle!', 'sourceUrl', 'uploads/ad110002-1000-4000-8000-000000000002/own.png')),
     'videos', jsonb_build_array(
       jsonb_build_object('assetId', 'asset-kept-1', 'sourceUrl', 'generation_inputs/ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/00-reference-image.png')),
     'audios', 'not a list'))),
  -- A remixer ran the creator's shared asset later: it stays the first runner's.
  ('ad110013-1000-4000-8000-000000000001', 'ad110003-1000-4000-8000-000000000003', 'seedance-2', 'succeeded', false, '2026-11-02T00:00:00Z',
   jsonb_build_object('seedanceAssets', jsonb_build_object(
     'images', jsonb_build_array(jsonb_build_object('assetId', 'asset-own-1', 'sourceUrl', 'uploads/ad110002-1000-4000-8000-000000000002/own.png')))));

select is(public.backfill_seedance_prepared_assets(), 4::bigint, 'the backfill records each well-formed asset id a run recorded, once');
select is(
  (select jsonb_object_agg(asset_id, jsonb_build_array(owner_user_id, recipe_file, recorded_from))
   from public.seedance_prepared_assets where asset_id like 'asset-%-1'),
  jsonb_build_object(
    'asset-own-1', jsonb_build_array('ad110002-1000-4000-8000-000000000002', null, 'run'),
    'asset-copy-1', jsonb_build_array('ad110002-1000-4000-8000-000000000002', 'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png', 'run'),
    'asset-import-1', jsonb_build_array('ad110002-1000-4000-8000-000000000002', 'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png', 'run'),
    'asset-kept-1', jsonb_build_array('ad110002-1000-4000-8000-000000000002', 'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png', 'run')),
  'each asset is classified by its file: own, the copy, an import of it, a kept input marked as it'
);
select is(public.backfill_seedance_prepared_assets(), 0::bigint, 'a second backfill adds nothing');
select ok(not has_function_privilege('service_role', 'public.backfill_seedance_prepared_assets()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.backfill_seedance_prepared_assets()', 'EXECUTE'),
  'no API role can run the backfill again over later runs');

-- A refund deletes the purchase: the copy and the kept input made from it close.
delete from public.post_resource_bundle_purchases where id = 'ad110050-1000-4000-8000-000000000001';
select ok(not public.recipe_file_readable_by('ad110002-1000-4000-8000-000000000002',
  'post_resource_files/ad110001-1000-4000-8000-000000000001/generation-references/ad110010-1000-4000-8000-000000000001/00-reference-image-row-1.png'),
  'after a refund the buyer reads the copy no more');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ad110002-1000-4000-8000-000000000002","role":"authenticated"}', true);
select is((select count(*) from storage.objects where bucket_id = 'generation_inputs'
  and name = 'ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/00-reference-image.png'),
  0::bigint, 'after a refund the kept input made from the copy closes to the buyer''s JWT');
select is((select count(*) from storage.objects where bucket_id = 'generation_inputs'
  and name = 'ad110002-1000-4000-8000-000000000002/ad110011-1000-4000-8000-000000000001/01-reference-image.png'),
  1::bigint, 'the buyer''s own kept input stays readable');
reset role;

-- ─── Grants ─────────────────────────────────────────────────────────────────

select ok(not has_function_privilege('authenticated', 'public.recipe_files_readable_by(uuid, text[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.recipe_files_readable_by(uuid, text[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.recipe_file_readable_by(uuid, text)', 'EXECUTE'),
  'only the server asks the read predicate');
select ok(has_function_privilege('service_role', 'public.recipe_files_readable_by(uuid, text[])', 'EXECUTE'),
  'the server may ask it');
select ok(has_function_privilege('authenticated', 'public.generation_input_object_readable(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.generation_input_object_readable(text)', 'EXECUTE'),
  'the read policy''s helper runs for a signed-in caller only');
select ok(not has_table_privilege('authenticated', 'public.seedance_prepared_assets', 'SELECT, INSERT, UPDATE, DELETE')
  and not has_table_privilege('anon', 'public.seedance_prepared_assets', 'SELECT, INSERT, UPDATE, DELETE'),
  'clients have no access to the Seedance asset records');
select ok(has_table_privilege('service_role', 'public.seedance_prepared_assets', 'SELECT, INSERT')
  and not has_table_privilege('service_role', 'public.seedance_prepared_assets', 'UPDATE')
  and not has_table_privilege('service_role', 'public.seedance_prepared_assets', 'DELETE'),
  'the server records an asset once and never rewrites it');
select ok((select relrowsecurity from pg_class where oid = 'public.seedance_prepared_assets'::regclass),
  'the Seedance asset records have row level security on');

select * from finish();
rollback;
