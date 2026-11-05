-- Remix runs record the terms of the recipe they came from
-- (20261105123244_remix_runs_record_their_recipe_terms.sql).
--
-- A run that remixes someone else's post records whether that post's recipe was
-- free or paid, which recipe it was and the chain's first creation. A run from
-- the caller's own creation inherits all three, and paid sticks down a chain.
-- A remix by the post's owner is no longer counted.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

select ok(
  (select bool_and(
       procedures.prosecdef
       and procedures.proconfig @> array['search_path=public, pg_temp']
       and not has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
       and not has_function_privilege('anon', procedures.oid, 'EXECUTE'))
   from pg_catalog.pg_proc as procedures
   where procedures.oid in (
     'public.remix_terms_for(uuid, uuid)'::regprocedure,
     'public.record_generation_remix_terms()'::regprocedure
   )),
  'the remix terms functions run as their owner with no client grants'
);

-- ─── Fixture ────────────────────────────────────────────────────────────────
-- A (…01) sells and gives recipes away. B (…02) remixes A. C (…03) remixes B.

insert into auth.users (
  id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data, created_at
) values
  ('d1a00000-0000-4000-8000-000000000001', 'remix-terms-a@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('d1a00000-0000-4000-8000-000000000002', 'remix-terms-b@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now()),
  ('d1a00000-0000-4000-8000-000000000003', 'remix-terms-c@example.invalid',
   'authenticated', 'authenticated', false, '{}', '{}', now());

-- A's three public creations: one with a paid recipe, one with a free recipe,
-- one with none.
insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public
) values
  ('d1b00000-0000-4000-8000-000000000001', 'd1a00000-0000-4000-8000-000000000001',
   'remix-terms-paid', 'succeeded', 1, 'image', 'test', 'https://example.invalid/paid.png', true),
  ('d1b00000-0000-4000-8000-000000000002', 'd1a00000-0000-4000-8000-000000000001',
   'remix-terms-free', 'succeeded', 1, 'image', 'test', 'https://example.invalid/free.png', true),
  ('d1b00000-0000-4000-8000-000000000003', 'd1a00000-0000-4000-8000-000000000001',
   'remix-terms-none', 'succeeded', 1, 'image', 'test', 'https://example.invalid/none.png', true);
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('d1c00000-0000-4000-8000-000000000001', 'd1a00000-0000-4000-8000-000000000001', 'public', 'image',
   'magicbooklet', 'd1b00000-0000-4000-8000-000000000001', 'https://example.invalid/paid.png'),
  ('d1c00000-0000-4000-8000-000000000002', 'd1a00000-0000-4000-8000-000000000001', 'public', 'image',
   'magicbooklet', 'd1b00000-0000-4000-8000-000000000002', 'https://example.invalid/free.png'),
  ('d1c00000-0000-4000-8000-000000000003', 'd1a00000-0000-4000-8000-000000000001', 'public', 'image',
   'magicbooklet', 'd1b00000-0000-4000-8000-000000000003', 'https://example.invalid/none.png');
insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text
) values
  ('d1d00000-0000-4000-8000-000000000001', 'd1c00000-0000-4000-8000-000000000001',
   'd1a00000-0000-4000-8000-000000000001', 'paid', 'published', 'Paid remix terms recipe', 200, 'Paid prompt'),
  ('d1d00000-0000-4000-8000-000000000002', 'd1c00000-0000-4000-8000-000000000002',
   'd1a00000-0000-4000-8000-000000000001', 'free', 'published', 'Free remix terms recipe', 0, 'Free prompt');

-- B buys A's paid recipe before remixing it, as Remix asks (remix-access.ts).
insert into public.post_resource_bundle_purchases (
  bundle_id, buyer_user_id, price_usd_cents, amount_subunits, currency
) values
  ('d1d00000-0000-4000-8000-000000000001', 'd1a00000-0000-4000-8000-000000000002', 200, 20000, 'INR');

-- ─── B remixes each of A's posts ────────────────────────────────────────────

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('d1b00000-0000-4000-8000-000000000011', 'd1a00000-0000-4000-8000-000000000002',
   'remix-terms-b-paid', 'processing', 1, 'image', 'test', 'd1b00000-0000-4000-8000-000000000001'),
  ('d1b00000-0000-4000-8000-000000000012', 'd1a00000-0000-4000-8000-000000000002',
   'remix-terms-b-free', 'processing', 1, 'image', 'test', 'd1b00000-0000-4000-8000-000000000002'),
  ('d1b00000-0000-4000-8000-000000000013', 'd1a00000-0000-4000-8000-000000000002',
   'remix-terms-b-none', 'processing', 1, 'image', 'test', 'd1b00000-0000-4000-8000-000000000003');

select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000011' $$,
  $$ values ('paid'::text, 'd1d00000-0000-4000-8000-000000000001'::uuid,
             'd1b00000-0000-4000-8000-000000000001'::uuid) $$,
  'a buyer''s remix of a post with a paid recipe is paid, names that recipe and starts the chain at the post''s creation'
);
select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000012' $$,
  $$ values ('free'::text, 'd1d00000-0000-4000-8000-000000000002'::uuid,
             'd1b00000-0000-4000-8000-000000000002'::uuid) $$,
  'a remix of a post with a free recipe is free'
);
select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000013' $$,
  $$ values ('free'::text, null::uuid, 'd1b00000-0000-4000-8000-000000000003'::uuid) $$,
  'a remix of a post with no recipe counts as free'
);

-- ─── B remixes B's own paid version ─────────────────────────────────────────

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('d1b00000-0000-4000-8000-000000000021', 'd1a00000-0000-4000-8000-000000000002',
   'remix-terms-b-self', 'processing', 1, 'image', 'test', 'd1b00000-0000-4000-8000-000000000011');
select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000021' $$,
  $$ values ('paid'::text, 'd1d00000-0000-4000-8000-000000000001'::uuid,
             'd1b00000-0000-4000-8000-000000000001'::uuid) $$,
  'a run from the caller''s own paid version inherits its terms'
);

-- ─── C remixes B's version, posted (as before this rule) with a free recipe ─

update public.generations
set status = 'succeeded', output_url = 'https://example.invalid/b-paid.png', is_public = true
where id = 'd1b00000-0000-4000-8000-000000000011';
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('d1c00000-0000-4000-8000-000000000011', 'd1a00000-0000-4000-8000-000000000002', 'public', 'image',
   'magicbooklet', 'd1b00000-0000-4000-8000-000000000011', 'https://example.invalid/b-paid.png');
insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text
) values
  ('d1d00000-0000-4000-8000-000000000011', 'd1c00000-0000-4000-8000-000000000011',
   'd1a00000-0000-4000-8000-000000000002', 'free', 'published', 'Free version of a paid recipe', 0, 'Paid prompt');
insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('d1b00000-0000-4000-8000-000000000031', 'd1a00000-0000-4000-8000-000000000003',
   'remix-terms-c', 'processing', 1, 'image', 'test', 'd1b00000-0000-4000-8000-000000000011');
select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000031' $$,
  $$ values ('paid'::text, 'd1d00000-0000-4000-8000-000000000011'::uuid,
             'd1b00000-0000-4000-8000-000000000001'::uuid) $$,
  'paid sticks: a remix of a paid version stays paid whatever its post''s recipe says, and keeps the chain''s first creation'
);

-- ─── What a caller sends for the columns is not kept ────────────────────────

insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, remix_recipe_mode, remix_origin_generation_id
) values
  ('d1b00000-0000-4000-8000-000000000041', 'd1a00000-0000-4000-8000-000000000003',
   'remix-terms-forged', 'processing', 1, 'image', 'test', 'paid', 'd1b00000-0000-4000-8000-000000000001');
select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000041' $$,
  $$ values (null::text, null::uuid, null::uuid) $$,
  'a run with no source records no terms, whatever its insert said'
);

-- ─── Only other people's remixes count ──────────────────────────────────────

select is(
  (select remix_count from public.posts where id = 'd1c00000-0000-4000-8000-000000000001'),
  1,
  'B''s completed remix counts on A''s post'
);

insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, source_generation_id, output_url
) values
  ('d1b00000-0000-4000-8000-000000000051', 'd1a00000-0000-4000-8000-000000000001',
   'remix-terms-a-self', 'succeeded', 1, 'image', 'test', 'd1b00000-0000-4000-8000-000000000001',
   'https://example.invalid/a-self.png');
select is(
  (select remix_count from public.posts where id = 'd1c00000-0000-4000-8000-000000000001'),
  1,
  'A''s own remix of A''s post does not count'
);
select is(
  (select count(*) from public.completed_post_remixes
   where generation_id = 'd1b00000-0000-4000-8000-000000000051'),
  0::bigint,
  'and records no alert'
);

-- ─── A purchase counts, in whatever state the recipe is now ────────────────
-- A sells a recipe, B buys it, then A takes it down: B's remix stays paid; C, who
-- never paid, remixes an open post. A free unlock (price 0) is no purchase here.

insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public
) values
  ('d1b00000-0000-4000-8000-000000000004', 'd1a00000-0000-4000-8000-000000000001',
   'remix-terms-retired', 'succeeded', 1, 'image', 'test', 'https://example.invalid/retired.png', true);
insert into public.posts (id, user_id, visibility, category, source_kind, generation_id, output_url) values
  ('d1c00000-0000-4000-8000-000000000004', 'd1a00000-0000-4000-8000-000000000001', 'public', 'image',
   'magicbooklet', 'd1b00000-0000-4000-8000-000000000004', 'https://example.invalid/retired.png');
insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text
) values
  ('d1d00000-0000-4000-8000-000000000004', 'd1c00000-0000-4000-8000-000000000004',
   'd1a00000-0000-4000-8000-000000000001', 'paid', 'published', 'Retired remix terms recipe', 200, 'Sold prompt');
insert into public.post_resource_bundle_purchases (
  bundle_id, buyer_user_id, price_usd_cents, amount_subunits, currency
) values
  ('d1d00000-0000-4000-8000-000000000004', 'd1a00000-0000-4000-8000-000000000002', 200, 20000, 'INR'),
  ('d1d00000-0000-4000-8000-000000000002', 'd1a00000-0000-4000-8000-000000000003', 0, 0, 'INR');
update public.post_resource_bundles
set status = 'draft', retired_at = now()
where id = 'd1d00000-0000-4000-8000-000000000004';

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
  ('d1b00000-0000-4000-8000-000000000061', 'd1a00000-0000-4000-8000-000000000002',
   'remix-terms-b-retired', 'processing', 1, 'image', 'test', 'd1b00000-0000-4000-8000-000000000004'),
  ('d1b00000-0000-4000-8000-000000000062', 'd1a00000-0000-4000-8000-000000000003',
   'remix-terms-c-retired', 'processing', 1, 'image', 'test', 'd1b00000-0000-4000-8000-000000000004');
select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000061' $$,
  $$ values ('paid'::text, 'd1d00000-0000-4000-8000-000000000004'::uuid) $$,
  'a buyer''s remix of a recipe taken down after the sale stays paid'
);
select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000062' $$,
  $$ values ('free'::text, null::uuid) $$,
  'and someone who never paid for it remixes an open post'
);
select is(
  public.remix_source_bought_paid('d1a00000-0000-4000-8000-000000000002', 'd1b00000-0000-4000-8000-000000000004'),
  true,
  'a paid purchase counts'
);
select is(
  public.remix_source_bought_paid('d1a00000-0000-4000-8000-000000000003', 'd1b00000-0000-4000-8000-000000000002'),
  false,
  'a free unlock does not'
);

-- ─── The post keeps its creation's mode ─────────────────────────────────────

select is(
  (select remix_recipe_mode from public.posts where id = 'd1c00000-0000-4000-8000-000000000011'),
  'paid',
  'a post copies its creation''s mode'
);
update public.posts set generation_id = null where id = 'd1c00000-0000-4000-8000-000000000011';
select is(
  (select remix_recipe_mode from public.posts where id = 'd1c00000-0000-4000-8000-000000000011'),
  'paid',
  'and keeps it when the creation goes'
);
update public.posts set remix_recipe_mode = 'free' where id = 'd1c00000-0000-4000-8000-000000000011';
select is(
  (select remix_recipe_mode from public.posts where id = 'd1c00000-0000-4000-8000-000000000011'),
  'paid',
  'and keeps nothing written to it directly'
);

-- ─── The backfill brings rows written before the rules under them ──────────

update public.generations
set remix_recipe_mode = null, remix_recipe_bundle_id = null, remix_origin_generation_id = null
where id = 'd1b00000-0000-4000-8000-000000000061';
-- An owner's own remix recorded before the rule, counted as it was then.
insert into public.completed_post_remixes (generation_id, post_id, actor_user_id, completed_at) values
  ('d1b00000-0000-4000-8000-000000000051', 'd1c00000-0000-4000-8000-000000000001',
   'd1a00000-0000-4000-8000-000000000001', now());
update public.posts set remix_count = remix_count + 1 where id = 'd1c00000-0000-4000-8000-000000000001';

select public.backfill_remix_recipe_terms();
select results_eq(
  $$ select remix_recipe_mode, remix_recipe_bundle_id, remix_origin_generation_id
     from public.generations where id = 'd1b00000-0000-4000-8000-000000000061' $$,
  $$ values ('paid'::text, 'd1d00000-0000-4000-8000-000000000004'::uuid,
             'd1b00000-0000-4000-8000-000000000004'::uuid) $$,
  'the backfill gives a run written before the rule its terms'
);
select is(
  (select count(*) from public.completed_post_remixes
   where generation_id = 'd1b00000-0000-4000-8000-000000000051'),
  0::bigint,
  'and drops the remix a post''s owner made'
);
select is(
  (select remix_count from public.posts where id = 'd1c00000-0000-4000-8000-000000000001'),
  1,
  'which takes it off the post''s count'
);

-- ─── Deleting a source keeps the terms of what was made from it ─────────────
-- B re-ran its paid version (…21) and C remixed it (…31); B deletes the version.

delete from public.generations where id = 'd1b00000-0000-4000-8000-000000000011';
select is(
  (select remix_recipe_mode from public.generations where id = 'd1b00000-0000-4000-8000-000000000021'),
  'paid',
  'a re-run keeps its terms when the run it came from is deleted'
);
select is(
  (select remix_recipe_mode from public.generations where id = 'd1b00000-0000-4000-8000-000000000031'),
  'paid',
  'and so does someone else''s remix of it'
);

select * from finish();
rollback;
