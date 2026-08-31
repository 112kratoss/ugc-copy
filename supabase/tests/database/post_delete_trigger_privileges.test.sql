-- Post deletion is performed by the API's service_role client. The delete
-- guards need owner privileges only for their narrow auth.users existence
-- check; application roles must not be able to invoke them directly.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

select is(
  (
    select count(*) = 2 and bool_and(procedures.prosecdef)
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = any (array[
      'public.reject_sold_post_delete()'::regprocedure,
      'public.protect_sold_post_resource_bundle_content()'::regprocedure
    ])
  ),
  true,
  'post and bundle delete guards run with their trusted owner privileges'
);

select is(
  (
    select count(*) = 2
      and bool_and(pg_catalog.pg_get_userbyid(procedures.proowner) = 'postgres')
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = any (array[
      'public.reject_sold_post_delete()'::regprocedure,
      'public.protect_sold_post_resource_bundle_content()'::regprocedure
    ])
  ),
  true,
  'post and bundle delete guards have the expected trusted owner'
);

select is(
  (
    select count(*) = 2
      and bool_and(procedures.proconfig @> array['search_path=""']::text[])
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = any (array[
      'public.reject_sold_post_delete()'::regprocedure,
      'public.protect_sold_post_resource_bundle_content()'::regprocedure
    ])
  ),
  true,
  'post and bundle delete guards have an empty fixed search path'
);

select is(
  (
    select coalesce(bool_or(
      pg_catalog.has_function_privilege('anon', procedures.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('service_role', procedures.oid, 'EXECUTE')
    ), false)
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = any (array[
      'public.reject_sold_post_delete()'::regprocedure,
      'public.protect_sold_post_resource_bundle_content()'::regprocedure
    ])
  ),
  false,
  'application roles cannot invoke the privileged delete guards directly'
);

insert into auth.users (
  id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at
)
values (
  'dd100000-0000-4000-8000-000000000001'::uuid,
  'post-delete-owner@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb,
  timezone('utc'::text, now())
);

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, body
)
values
  (
    'dd200000-0000-4000-8000-000000000001'::uuid,
    'dd100000-0000-4000-8000-000000000001'::uuid,
    'public', 'text', 'external', 'text', 'ordinary post delete fixture'
  ),
  (
    'dd200000-0000-4000-8000-000000000002'::uuid,
    'dd100000-0000-4000-8000-000000000001'::uuid,
    'public', 'text', 'external', 'text', 'unsold bundle delete fixture'
  );

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary,
  preview_text, prompt_text, price_usd_cents
)
values (
  'dd300000-0000-4000-8000-000000000001'::uuid,
  'dd200000-0000-4000-8000-000000000002'::uuid,
  'dd100000-0000-4000-8000-000000000001'::uuid,
  'paid', 'published', 'Unsold recipe', 'Nobody bought this recipe.',
  'Unsold recipe preview.', 'UNSOLD PROMPT', 500
);

set local role service_role;

select lives_ok(
  $$delete from public.posts
    where id = 'dd200000-0000-4000-8000-000000000001'::uuid$$,
  'service_role can hard-delete an ordinary post'
);

select is(
  (
    select count(*)::integer
    from public.posts
    where id = 'dd200000-0000-4000-8000-000000000001'::uuid
  ),
  0,
  'the ordinary post is removed'
);

select lives_ok(
  $$delete from public.posts
    where id = 'dd200000-0000-4000-8000-000000000002'::uuid$$,
  'service_role can hard-delete a post with an unsold bundle'
);

select is(
  (
    select count(*)::integer
    from public.posts
    where id = 'dd200000-0000-4000-8000-000000000002'::uuid
  ),
  0,
  'the post with an unsold bundle is removed'
);

select is(
  (
    select count(*)::integer
    from public.post_resource_bundles
    where id = 'dd300000-0000-4000-8000-000000000001'::uuid
  ),
  0,
  'the unsold bundle follows its deleted post'
);

select * from finish();
rollback;
