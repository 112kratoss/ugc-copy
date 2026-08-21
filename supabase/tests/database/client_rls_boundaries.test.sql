-- Client-facing RLS boundaries, exercised the way PostgREST executes queries:
-- as the `authenticated` / `anon` roles with JWT claims applied. The other
-- database suites validate RPC behaviour as the owner; this one proves the
-- row and column boundaries hold for real client roles.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(15);

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

-- ─── Column grants on generations (row owner) ────────────────────────────────

-- The authenticated role holds a column-scoped SELECT on generations: enough
-- to resume your own work, and nothing more. Anything richer — prompts,
-- settings, media, visibility — is service-role only, behind an explicit
-- authorization check in the service layer.
--
-- Both directions are pinned on purpose. Column privileges are evaluated
-- before row policies, so an ungranted column fails the whole statement even
-- for the row's own owner; narrowing this projection on 2026-07-26 silently
-- broke remix, publishing, and workflow-run hydration in production, and each
-- was found only when users reported dead buttons. Widening it would hand back
-- the data that hardening removed. Either direction should be a deliberate
-- change that updates this test and the readers that depend on it.
--
-- production_data_contract.test.sql also pins `prompt`, but against another
-- user's row, where row policies would hide it anyway. These run against the
-- caller's own row on purpose: that is the only way to show the denial comes
-- from the column grant rather than from RLS, which is precisely the
-- distinction that made the 2026-07-26 breakage so hard to see.

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub": "0000000b-0000-4000-8000-0000000000b1", "role": "authenticated"}',
  true
);

select lives_ok(
  $$
    select id, user_id, prediction_id, status, created_at, duration, category, creation_mode
    from public.generations
    where id = 'a0000000-0000-4000-8000-000000000002'::uuid
  $$,
  'the resume projection stays readable for the row owner'
);

select throws_ok(
  $$
    select prompt from public.generations
    where id = 'a0000000-0000-4000-8000-000000000002'::uuid
  $$,
  '42501',
  null,
  'prompt is not granted to authenticated, even on the caller''s own row'
);

select throws_ok(
  $$
    select workflow_settings from public.generations
    where id = 'a0000000-0000-4000-8000-000000000002'::uuid
  $$,
  '42501',
  null,
  'workflow_settings is not granted to authenticated (remix reads it service-role)'
);

select throws_ok(
  $$
    select is_public from public.generations
    where id = 'a0000000-0000-4000-8000-000000000002'::uuid
  $$,
  '42501',
  null,
  'is_public is not granted to authenticated (source validation reads it service-role)'
);

select throws_ok(
  $$
    select output_url from public.generations
    where id = 'a0000000-0000-4000-8000-000000000002'::uuid
  $$,
  '42501',
  null,
  'output_url is not granted to authenticated (run hydration reads it service-role)'
);

-- ─── Anonymous client ────────────────────────────────────────────────────────

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);

select throws_ok(
  $$
    select id from public.generations
    where id = 'a0000000-0000-4000-8000-000000000004'::uuid
  $$,
  '42501',
  null,
  'an anonymous client cannot query public generations directly'
);

select throws_ok(
  $$
    select id from public.generations
    where id = 'a0000000-0000-4000-8000-000000000002'::uuid
  $$,
  '42501',
  null,
  'an anonymous client cannot query private generations directly'
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

-- Profiles also have no anonymous table grant. Pin the outer privilege
-- boundary so a later permissive policy cannot turn a zero-row query into an
-- accidental public projection.
select throws_ok(
  $$ select id from public.profiles limit 1 $$,
  '42501',
  null,
  'an anonymous client cannot query profiles directly'
);

reset role;

select * from finish();
rollback;
