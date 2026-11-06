-- A remix's recipe passes on the files that came through the recipe it remixed,
-- and each passed-on copy is served only while what it came from is
-- (20261105150428): A sells a recipe, B bought it and passed one of its files on
-- in B's own recipe, C bought B's and passed it on again, D bought C's.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(51);

insert into auth.users(id, email, aud, role, created_at, is_anonymous, raw_app_meta_data, raw_user_meta_data)
values
  ('ad120001-1000-4000-8000-000000000001', 'pass-on-a@example.invalid', 'authenticated', 'authenticated', now(), false, '{}', '{}'),
  ('ad120002-1000-4000-8000-000000000002', 'pass-on-b@example.invalid', 'authenticated', 'authenticated', now(), false, '{}', '{}'),
  ('ad120003-1000-4000-8000-000000000003', 'pass-on-c@example.invalid', 'authenticated', 'authenticated', now(), false, '{}', '{}'),
  ('ad120004-1000-4000-8000-000000000004', 'pass-on-d@example.invalid', 'authenticated', 'authenticated', now(), false, '{}', '{}'),
  ('ad120005-1000-4000-8000-000000000005', 'pass-on-stranger@example.invalid', 'authenticated', 'authenticated', now(), false, '{}', '{}');

-- A's, B's and C's creations, each on a public post.
insert into public.generations(id, user_id, model, status, is_public)
values
  ('ad120010-1000-4000-8000-00000000000a', 'ad120001-1000-4000-8000-000000000001', 'test-model', 'succeeded', true),
  ('ad120010-1000-4000-8000-00000000000b', 'ad120002-1000-4000-8000-000000000002', 'test-model', 'succeeded', true),
  ('ad120010-1000-4000-8000-00000000000c', 'ad120003-1000-4000-8000-000000000003', 'test-model', 'succeeded', true);

insert into public.posts(id, user_id, generation_id, title, body, category, post_format, source_kind, visibility, output_url)
values
  ('ad120020-1000-4000-8000-00000000000a', 'ad120001-1000-4000-8000-000000000001', 'ad120010-1000-4000-8000-00000000000a',
   'A recipe post', 'Synthetic fixture.', 'image', 'media', 'external', 'public', 'generated_images/pass-on-a.png'),
  ('ad120020-1000-4000-8000-00000000000b', 'ad120002-1000-4000-8000-000000000002', 'ad120010-1000-4000-8000-00000000000b',
   'B recipe post', 'Synthetic fixture.', 'image', 'media', 'external', 'public', 'generated_images/pass-on-b.png'),
  ('ad120020-1000-4000-8000-00000000000c', 'ad120003-1000-4000-8000-000000000003', 'ad120010-1000-4000-8000-00000000000c',
   'C recipe post', 'Synthetic fixture.', 'image', 'media', 'external', 'public', 'generated_images/pass-on-c.png');
set constraints all immediate;

-- A's recipe lists A's copy; B's lists B's copy of it and a copy of B's own upload; C's lists C's copy of B's.
insert into public.post_resource_bundles(id, post_id, owner_user_id, access_mode, status, title, summary, preview_text, prompt_text, price_usd_cents, resource_items)
values
  ('ad120030-1000-4000-8000-00000000000a', 'ad120020-1000-4000-8000-00000000000a', 'ad120001-1000-4000-8000-000000000001',
   'paid', 'published', 'Recipe', 'Summary', 'Preview', 'Prompt', 500,
   '[{"id":"reference-row-a","type":"reference_image","title":"Hero","storagePath":"ad120001-1000-4000-8000-000000000001/generation-references/ad120010-1000-4000-8000-00000000000a/00-reference-image-row-a.png"}]'::jsonb),
  ('ad120030-1000-4000-8000-00000000000b', 'ad120020-1000-4000-8000-00000000000b', 'ad120002-1000-4000-8000-000000000002',
   'paid', 'published', 'Recipe', 'Summary', 'Preview', 'Prompt', 500,
   '[{"id":"reference-row-b","type":"reference_image","title":"Hero","storagePath":"ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/00-reference-image-row-b.png"},
     {"id":"reference-row-b-own","type":"reference_image","title":"Own","storagePath":"ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/01-reference-image-row-b-own.png"}]'::jsonb),
  ('ad120030-1000-4000-8000-00000000000c', 'ad120020-1000-4000-8000-00000000000c', 'ad120003-1000-4000-8000-000000000003',
   'paid', 'published', 'Recipe', 'Summary', 'Preview', 'Prompt', 500,
   '[{"id":"reference-row-c","type":"reference_image","title":"Hero","storagePath":"ad120003-1000-4000-8000-000000000003/generation-references/ad120010-1000-4000-8000-00000000000c/00-reference-image-row-c.png"}]'::jsonb);

-- B buys A's recipe, C buys B's, D buys C's.
insert into public.post_resource_bundle_orders(id, bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id, amount_subunits, currency, status, quoted_price_usd_cents, quoted_revision_id, quoted_content_fingerprint, quoted_media)
select ('ad120040-1000-4000-8000-00000000000' || buyer.tag)::uuid, ('ad120030-1000-4000-8000-00000000000' || buyer.bundle_tag)::uuid,
  buyer.id, 'order_pass_on_' || buyer.tag, 'pay_pass_on_' || buyer.tag, 500, 'USD', 'created', 500, r.id, r.content_fingerprint, '[]'::jsonb
from (values
  ('ad120002-1000-4000-8000-000000000002'::uuid, 'b', 'a'),
  ('ad120003-1000-4000-8000-000000000003'::uuid, 'c', 'b'),
  ('ad120004-1000-4000-8000-000000000004'::uuid, 'd', 'c')
) as buyer(id, tag, bundle_tag)
cross join lateral (
  select revision.id, revision.content_fingerprint
  from public.post_resource_bundle_revisions revision
  where revision.bundle_id = ('ad120030-1000-4000-8000-00000000000' || buyer.bundle_tag)::uuid
  order by revision.revision_number desc limit 1
) r;
insert into public.post_resource_bundle_purchases(id, bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency)
values
  ('ad120050-1000-4000-8000-00000000000b', 'ad120030-1000-4000-8000-00000000000a', 'ad120002-1000-4000-8000-000000000002', 'ad120040-1000-4000-8000-00000000000b', 500, 500, 'USD'),
  ('ad120050-1000-4000-8000-00000000000c', 'ad120030-1000-4000-8000-00000000000b', 'ad120003-1000-4000-8000-000000000003', 'ad120040-1000-4000-8000-00000000000c', 500, 500, 'USD'),
  ('ad120050-1000-4000-8000-00000000000d', 'ad120030-1000-4000-8000-00000000000c', 'ad120004-1000-4000-8000-000000000004', 'ad120040-1000-4000-8000-00000000000d', 500, 500, 'USD');

-- Where B's and C's passed-on copies came from, as the server records them with each copy.
insert into public.recipe_copy_sources(copy_path, source_file, holder_user_id)
values
  ('post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/00-reference-image-row-b.png',
   'post_resource_files/ad120001-1000-4000-8000-000000000001/generation-references/ad120010-1000-4000-8000-00000000000a/00-reference-image-row-a.png',
   'ad120002-1000-4000-8000-000000000002'),
  ('post_resource_files/ad120003-1000-4000-8000-000000000003/generation-references/ad120010-1000-4000-8000-00000000000c/00-reference-image-row-c.png',
   'post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/00-reference-image-row-b.png',
   'ad120003-1000-4000-8000-000000000003');

-- C's run kept B's copy as an input of its own, marked as a recipe file.
insert into public.generation_input_media(generation_id, user_id, media_type, role, label, storage_path, sort_order, metadata)
values ('ad120010-1000-4000-8000-00000000000c', 'ad120003-1000-4000-8000-000000000003', 'image', 'reference_image', 'Hero',
  'generation_inputs/ad120003-1000-4000-8000-000000000003/ad120010-1000-4000-8000-00000000000c/00-reference-image.png', 0,
  '{"sourceKind":"recipe-file","recipeFile":"post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/00-reference-image-row-b.png"}'::jsonb);
insert into storage.objects(id, bucket_id, name, version, metadata, created_at)
values ('ad120060-1000-4000-8000-000000000001', 'generation_inputs',
  'ad120003-1000-4000-8000-000000000003/ad120010-1000-4000-8000-00000000000c/00-reference-image.png', 'v1', '{}'::jsonb, now());

create temporary table paths(name text primary key, path text not null) on commit drop;
insert into paths values
  ('a', 'post_resource_files/ad120001-1000-4000-8000-000000000001/generation-references/ad120010-1000-4000-8000-00000000000a/00-reference-image-row-a.png'),
  ('b', 'post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/00-reference-image-row-b.png'),
  ('b_own', 'post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/01-reference-image-row-b-own.png'),
  ('c', 'post_resource_files/ad120003-1000-4000-8000-000000000003/generation-references/ad120010-1000-4000-8000-00000000000c/00-reference-image-row-c.png');

create function pg_temp.readable(p_viewer text, p_name text) returns boolean language sql as $$
  select public.recipe_file_readable_by(p_viewer::uuid, (select path from paths where name = p_name));
$$;
create function pg_temp.withheld() returns text[] language sql as $$
  select array(
    select paths.name from paths
    where paths.path = any(public.recipe_copies_withheld(array(select path from paths)))
    order by paths.name
  );
$$;

-- ─── While everything stands ────────────────────────────────────────────────

select ok(pg_temp.readable('ad120003-1000-4000-8000-000000000003', 'b'), 'C reads B''s passed-on copy while B''s unlock of A''s holds');
select ok(pg_temp.readable('ad120004-1000-4000-8000-000000000004', 'c'), 'D reads C''s copy of it, down the chain');
select ok(pg_temp.readable('ad120003-1000-4000-8000-000000000003', 'b_own'), 'C reads B''s own copy');
select ok(pg_temp.readable('ad120002-1000-4000-8000-000000000002', 'b'), 'B reads their own passed-on copy');
select ok(not pg_temp.readable('ad120005-1000-4000-8000-000000000005', 'b'), 'a stranger reads none of it');
select is(pg_temp.withheld(), '{}'::text[], 'no copy is withheld');
select is(
  public.recipe_copies_withheld(array['ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/00-reference-image-row-b.png', 'ad120002-1000-4000-8000-000000000002/notes/guide.png']),
  '{}'::text[], 'the batch reads a path without its bucket, and withholds no file that is no copy');

-- ─── A archives their creation ──────────────────────────────────────────────

update public.generations set archived_at = now() where id = 'ad120010-1000-4000-8000-00000000000a';
select ok(not pg_temp.readable('ad120003-1000-4000-8000-000000000003', 'b'), 'A''s archive withholds B''s copy of A''s file from C');
select ok(not pg_temp.readable('ad120004-1000-4000-8000-000000000004', 'c'), 'and C''s copy of it from D');
select ok(pg_temp.readable('ad120003-1000-4000-8000-000000000003', 'b_own'), 'B''s own copy stays C''s');
select ok(not pg_temp.readable('ad120002-1000-4000-8000-000000000002', 'b'), 'B no longer opens their own copy of A''s file');
select ok(pg_temp.readable('ad120002-1000-4000-8000-000000000002', 'b_own'), 'B still opens their own copy');
select ok(pg_temp.readable('ad120001-1000-4000-8000-000000000001', 'a'), 'A still reads their own copy of their archived creation');
select is(pg_temp.withheld(), array['a', 'b', 'c'], 'the batch withholds A''s copy and both copies of it, and nothing else');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ad120003-1000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from storage.objects where bucket_id = 'generation_inputs'
  and name = 'ad120003-1000-4000-8000-000000000003/ad120010-1000-4000-8000-00000000000c/00-reference-image.png'),
  0::bigint, 'C''s kept input made from B''s copy closes to C''s JWT');
reset role;

update public.generations set archived_at = null where id = 'ad120010-1000-4000-8000-00000000000a';
select ok(pg_temp.readable('ad120004-1000-4000-8000-000000000004', 'c'), 'un-archiving serves the chain again');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ad120003-1000-4000-8000-000000000003","role":"authenticated"}', true);
select is((select count(*) from storage.objects where bucket_id = 'generation_inputs'
  and name = 'ad120003-1000-4000-8000-000000000003/ad120010-1000-4000-8000-00000000000c/00-reference-image.png'),
  1::bigint, 'and C''s kept input opens again');
reset role;

-- ─── An operator removes A's creation ───────────────────────────────────────

update public.generations set moderation_removed_at = now() where id = 'ad120010-1000-4000-8000-00000000000a';
select ok(not pg_temp.readable('ad120004-1000-4000-8000-000000000004', 'c'), 'an operator''s removal reaches the end of the chain');
update public.generations set moderation_removed_at = null where id = 'ad120010-1000-4000-8000-00000000000a';

-- ─── B's unlock of A's recipe ends ──────────────────────────────────────────

update public.post_resource_bundle_purchases set moderation_retracted_at = now() where id = 'ad120050-1000-4000-8000-00000000000b';
select ok(not pg_temp.readable('ad120003-1000-4000-8000-000000000003', 'b'), 'a retracted purchase of A''s recipe withholds B''s copy from C');
select ok(not pg_temp.readable('ad120004-1000-4000-8000-000000000004', 'c'), 'and from D');
select ok(not pg_temp.readable('ad120002-1000-4000-8000-000000000002', 'b'), 'and from B');
select ok(pg_temp.readable('ad120003-1000-4000-8000-000000000003', 'b_own'), 'B''s own copy stays C''s');
select is(pg_temp.withheld(), array['b', 'c'], 'the batch withholds both copies of A''s file');
update public.post_resource_bundle_purchases set moderation_retracted_at = null where id = 'ad120050-1000-4000-8000-00000000000b';

-- ─── B archives their own creation ──────────────────────────────────────────

update public.generations set archived_at = now() where id = 'ad120010-1000-4000-8000-00000000000b';
select ok(not pg_temp.readable('ad120003-1000-4000-8000-000000000003', 'b_own'), 'B''s archive withholds every copy of B''s creation from C, as before');
select ok(not pg_temp.readable('ad120004-1000-4000-8000-000000000004', 'c'), 'and C''s copy of B''s file from D');
select ok(pg_temp.readable('ad120002-1000-4000-8000-000000000002', 'b'), 'B still opens their own passed-on copy while A''s file is theirs');
update public.generations set archived_at = null where id = 'ad120010-1000-4000-8000-00000000000b';

-- ─── B's account is deleted ─────────────────────────────────────────────────

-- The record keeps the copy with no holder (ON DELETE SET NULL), as an erasure leaves it.
update public.recipe_copy_sources set holder_user_id = null
where copy_path = (select path from paths where name = 'b');
select ok(pg_temp.readable('ad120003-1000-4000-8000-000000000003', 'b'), 'with B''s account gone, C keeps the copy C bought');
select ok(pg_temp.readable('ad120004-1000-4000-8000-000000000004', 'c'), 'and D keeps C''s');
update public.generations set moderation_removed_at = now() where id = 'ad120010-1000-4000-8000-00000000000a';
select ok(not pg_temp.readable('ad120004-1000-4000-8000-000000000004', 'c'), 'an operator''s removal of A''s creation still reaches the end of the chain');
update public.generations set moderation_removed_at = null where id = 'ad120010-1000-4000-8000-00000000000a';
select ok(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.recipe_copy_sources'::regclass and contype = 'f' and confdeltype = 'n'
  ),
  'deleting a holder''s account keeps the record, with no holder'
);
update public.recipe_copy_sources set holder_user_id = 'ad120002-1000-4000-8000-000000000002'
where copy_path = (select path from paths where name = 'b');

-- ─── A chain that loops closes ──────────────────────────────────────────────

insert into public.recipe_copy_sources(copy_path, source_file, holder_user_id)
values
  ('post_resource_files/ad120001-1000-4000-8000-000000000001/generation-references/ad120010-1000-4000-8000-00000000000a/90-loop-1.png',
   'post_resource_files/ad120005-1000-4000-8000-000000000005/generation-references/ad120010-1000-4000-8000-00000000000e/91-loop-2.png',
   'ad120001-1000-4000-8000-000000000001'),
  ('post_resource_files/ad120005-1000-4000-8000-000000000005/generation-references/ad120010-1000-4000-8000-00000000000e/91-loop-2.png',
   'post_resource_files/ad120001-1000-4000-8000-000000000001/generation-references/ad120010-1000-4000-8000-00000000000a/90-loop-1.png',
   'ad120005-1000-4000-8000-000000000005');
select ok(not public.recipe_file_readable_by('ad120001-1000-4000-8000-000000000001',
  'post_resource_files/ad120001-1000-4000-8000-000000000001/generation-references/ad120010-1000-4000-8000-00000000000a/90-loop-1.png'),
  'a loop of records closes the copy rather than following it for ever');

-- ─── #708's max review ──────────────────────────────────────────────────────

-- A spelling with a percent sign is withheld: the file route decodes it, and no save writes one.
select ok(
  'post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/%30%30-reference-image-row-b.png'
    = any(public.recipe_copies_withheld(array['post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/%30%30-reference-image-row-b.png'])),
  'a copy spelled with a percent sign is withheld by the batch');
select ok(public.recipe_copy_withheld_at(
  'post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000%62/00-x.png', 0),
  'and by the single read, an encoded creation segment included');
-- A creation deleted outright keeps its post serving: its copies on no record are not withheld.
select is(public.recipe_copies_withheld(array[
  'post_resource_files/ad120005-1000-4000-8000-000000000005/generation-references/ad120010-1000-4000-8000-0000000000ff/00-gone.png']),
  '{}'::text[], 'a copy of a creation deleted outright, on no record, is not withheld');

-- A long chain of copies, each on the one before (no holder, so only where each came from counts).
insert into public.recipe_copy_sources(copy_path, source_file, holder_user_id)
select 'post_resource_files/chain-' || n || '/generation-references/ad120010-1000-4000-8000-0000000000ee/link.png',
       'post_resource_files/chain-' || (n - 1) || '/generation-references/ad120010-1000-4000-8000-0000000000ee/link.png',
       null
from generate_series(1, 70) as n;
select is(public.recipe_copies_withheld(array['post_resource_files/chain-20/generation-references/ad120010-1000-4000-8000-0000000000ee/link.png']),
  '{}'::text[], 'a chain of twenty copies is followed to its end and served');
select is(public.recipe_copies_withheld(array['post_resource_files/chain-70/generation-references/ad120010-1000-4000-8000-0000000000ee/link.png']),
  array['post_resource_files/chain-70/generation-references/ad120010-1000-4000-8000-0000000000ee/link.png'],
  'a chain past sixty-four copies closes');

-- A run records the recipe its maker holds, a free claim of one now back in draft included: the run
-- imports that recipe's copies, and its recipe passes them on (the hub's rule, 2026-11-06).
insert into public.post_resource_bundle_purchases(bundle_id, buyer_user_id, price_usd_cents, amount_subunits, currency)
values ('ad120030-1000-4000-8000-00000000000b', 'ad120005-1000-4000-8000-000000000005', 0, 0, 'USD');
update public.post_resource_bundles set status = 'draft' where id = 'ad120030-1000-4000-8000-00000000000b';
insert into public.generations(id, user_id, model, status, is_public, source_generation_id)
values ('ad120010-1000-4000-8000-0000000000dd', 'ad120005-1000-4000-8000-000000000005', 'test-model', 'succeeded', false,
        'ad120010-1000-4000-8000-00000000000b');
select is(
  (select remix_recipe_bundle_id from public.generations where id = 'ad120010-1000-4000-8000-0000000000dd'),
  'ad120030-1000-4000-8000-00000000000b'::uuid,
  'a remix by someone who claimed the recipe records it, though it is no longer published');
-- The owner, 2026-11-06 ("B's recipe must be paid"): that claim was free, the recipe is paid now.
select is(
  (select remix_recipe_mode from public.generations where id = 'ad120010-1000-4000-8000-0000000000dd'),
  'paid',
  'a holder''s run through an earlier free claim of a recipe now paid is a paid-recipe remix');
-- Someone who never held the recipe: unchanged (free, no recipe recorded).
insert into public.generations(id, user_id, model, status, is_public, source_generation_id)
values ('ad120010-1000-4000-8000-0000000000de', 'ad120004-1000-4000-8000-000000000004', 'test-model', 'succeeded', false,
        'ad120010-1000-4000-8000-00000000000a');
select is(
  (select remix_recipe_mode || ':' || coalesce(remix_recipe_bundle_id::text, 'none') from public.generations where id = 'ad120010-1000-4000-8000-0000000000de'),
  'free:ad120030-1000-4000-8000-00000000000a',
  'a remix by someone who never held the recipe keeps phase 1''s terms');
-- The run start's refusal reads the same: a free claimer of a recipe paid now holds it on paid terms.
select ok(public.remix_source_held_paid('ad120005-1000-4000-8000-000000000005', 'ad120010-1000-4000-8000-00000000000b'),
  'a free claim of a recipe now paid holds it on paid terms');
select ok(not public.remix_source_bought_paid('ad120005-1000-4000-8000-000000000005', 'ad120010-1000-4000-8000-00000000000b'),
  'though the claimer paid nothing');
select ok(not public.remix_source_held_paid('ad120004-1000-4000-8000-000000000004', 'ad120010-1000-4000-8000-00000000000a'),
  'someone who never held the recipe holds nothing on paid terms');

-- ─── What the table holds ───────────────────────────────────────────────────

select throws_ok($$
  insert into public.recipe_copy_sources(copy_path, source_file, holder_user_id) values (
    'post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/02-x.png',
    'post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000a/02-y.png',
    'ad120002-1000-4000-8000-000000000002')
$$, '23514', null, 'a copy never stands on a file of its own publisher''s');
select throws_ok($$
  insert into public.recipe_copy_sources(copy_path, source_file, holder_user_id) values (
    'post_resource_files/ad120002-1000-4000-8000-000000000002/notes/guide.png',
    'post_resource_files/ad120001-1000-4000-8000-000000000001/generation-references/ad120010-1000-4000-8000-00000000000a/00-reference-image-row-a.png',
    'ad120002-1000-4000-8000-000000000002')
$$, '23514', null, 'only a copy of a creation''s input is recorded');
select throws_ok($$
  insert into public.recipe_copy_sources(copy_path, source_file, holder_user_id) values (
    'post_resource_files/ad120002-1000-4000-8000-000000000002/generation-references/ad120010-1000-4000-8000-00000000000b/00-reference-image-row-b.png',
    'post_resource_files/ad120001-1000-4000-8000-000000000001/generation-references/ad120010-1000-4000-8000-00000000000a/00-reference-image-row-a.png',
    'ad120002-1000-4000-8000-000000000002')
$$, '23505', null, 'a copy is recorded once');

-- ─── Grants ─────────────────────────────────────────────────────────────────

select ok(not has_table_privilege('authenticated', 'public.recipe_copy_sources', 'SELECT, INSERT, UPDATE, DELETE')
  and not has_table_privilege('anon', 'public.recipe_copy_sources', 'SELECT, INSERT, UPDATE, DELETE'),
  'clients have no access to where copies came from');
select ok(has_table_privilege('service_role', 'public.recipe_copy_sources', 'SELECT, INSERT')
  and not has_table_privilege('service_role', 'public.recipe_copy_sources', 'UPDATE')
  and not has_table_privilege('service_role', 'public.recipe_copy_sources', 'DELETE'),
  'the server records a copy once and never rewrites it');
select ok((select relrowsecurity from pg_class where oid = 'public.recipe_copy_sources'::regclass), 'row level security is on');
select ok(not has_function_privilege('authenticated', 'public.recipe_copies_withheld(text[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.recipe_copies_withheld(text[])', 'EXECUTE')
  and has_function_privilege('service_role', 'public.recipe_copies_withheld(text[])', 'EXECUTE'),
  'only the server asks which copies are withheld');
select ok(not has_function_privilege('authenticated', 'public.recipe_copy_source_withheld_at(text, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.recipe_copy_withheld_at(text, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.recipe_file_readable_at(uuid, text, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.recipe_file_readable_at(uuid, text, integer)', 'EXECUTE'),
  'no client calls the walk itself');
select ok(not has_function_privilege('authenticated', 'public.recipe_file_readable_by(uuid, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.recipe_file_readable_by(uuid, text)', 'EXECUTE'),
  'the read predicate keeps its grants');

select * from finish();
rollback;
