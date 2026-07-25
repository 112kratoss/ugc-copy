-- Client-facing RLS boundaries, exercised the way PostgREST executes queries:
-- as the `authenticated` / `anon` roles with JWT claims applied. The other
-- database suites validate RPC behaviour as the owner; this one proves the
-- row and column boundaries hold for real client roles.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('0000000a-0000-4000-8000-0000000000a1'::uuid, 'rls-user-a@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('0000000b-0000-4000-8000-0000000000b1'::uuid, 'rls-user-b@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

update public.profiles set credits = 250
where id = '0000000b-0000-4000-8000-0000000000b1'::uuid;

insert into public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
values (
  'a0000000-0000-4000-8000-000000000001'::uuid,
  '0000000b-0000-4000-8000-0000000000b1'::uuid,
  'order_rls_boundary', 49900, 500, 'created'
);

insert into public.generations (id, user_id, model, status, is_public)
values
  ('a0000000-0000-4000-8000-000000000002'::uuid,
   '0000000b-0000-4000-8000-0000000000b1'::uuid,
   'test-model', 'succeeded', false),
  ('a0000000-0000-4000-8000-000000000004'::uuid,
   '0000000b-0000-4000-8000-0000000000b1'::uuid,
   'test-model', 'succeeded', true);

insert into public.posts (id, user_id, visibility, category, source_kind, title, output_url)
values (
  'a0000000-0000-4000-8000-000000000003'::uuid,
  '0000000b-0000-4000-8000-0000000000b1'::uuid,
  'public', 'image', 'external', 'Public boundary post',
  'generated_images/rls-boundary-post.png'
);

-- ─── Authenticated client (user A) ───────────────────────────────────────────

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "0000000a-0000-4000-8000-0000000000a1", "role": "authenticated"}',
  true
);

select is(
  (select count(*) from public.profiles
   where id = '0000000a-0000-4000-8000-0000000000a1'::uuid),
  1::bigint,
  'an authenticated user can read their own profile row'
);

select is(
  (select count(*) from public.profiles
   where id = '0000000b-0000-4000-8000-0000000000b1'::uuid),
  0::bigint,
  'an authenticated user cannot read another user''s profile or credits'
);

select throws_ok(
  $$
    update public.profiles
    set credits = 999999
    where id = '0000000a-0000-4000-8000-0000000000a1'::uuid
  $$,
  '42501',
  null,
  'an authenticated user cannot update their own credits column'
);

select is(
  (select count(*) from public.transactions
   where user_id = '0000000b-0000-4000-8000-0000000000b1'::uuid),
  0::bigint,
  'an authenticated user cannot read another user''s transactions'
);

select is(
  (select count(*) from public.generations
   where id = 'a0000000-0000-4000-8000-000000000002'::uuid),
  0::bigint,
  'an authenticated user cannot read another user''s private generations'
);

select throws_ok(
  $$
    insert into public.transactions (user_id, razorpay_order_id, amount, credits, status)
    values ('0000000a-0000-4000-8000-0000000000a1'::uuid, 'order_forged', 100, 100000, 'success')
  $$,
  '42501',
  null,
  'an authenticated user cannot insert transactions directly'
);

-- ─── Anonymous client ────────────────────────────────────────────────────────

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select is(
  (select count(*) from public.generations
   where id = 'a0000000-0000-4000-8000-000000000004'::uuid),
  1::bigint,
  'an anonymous client can read public generations'
);

select is(
  (select count(*) from public.generations
   where id = 'a0000000-0000-4000-8000-000000000002'::uuid),
  0::bigint,
  'an anonymous client cannot read private generations'
);

-- Posts intentionally carry no client table grants: every post read goes
-- through the API's service client, so even public posts are not directly
-- queryable by the anon role.
select throws_ok(
  $$
    select id from public.posts
    where id = 'a0000000-0000-4000-8000-000000000003'::uuid
  $$,
  '42501',
  null,
  'an anonymous client cannot query posts directly (service-layer only)'
);

select is(
  (select count(*) from public.profiles),
  0::bigint,
  'an anonymous client cannot read profiles'
);

reset role;

select * from finish();
rollback;
