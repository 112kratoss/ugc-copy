-- A profile is written by the API alone: no Data API role may change a row, its own included.
-- Before 20261126 an account could set its own handle, website, avatar and bio through PostgREST,
-- past the reserved handles and every other rule the API holds a save to.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

select ok(not has_table_privilege('authenticated', 'public.profiles', 'UPDATE'), 'authenticated holds no table-level UPDATE on profiles');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'INSERT'), 'authenticated cannot insert a profile');
select ok(not has_table_privilege('authenticated', 'public.profiles', 'DELETE'), 'authenticated cannot delete a profile');
select ok(not has_table_privilege('anon', 'public.profiles', 'UPDATE'), 'anon holds no table-level UPDATE on profiles');

-- Column grants are a second list, which the table-level question above does not read.
select is(
  (select count(*)::int from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'profiles'
     and grantee in ('anon', 'authenticated')
     and privilege_type in ('INSERT', 'UPDATE')),
  0,
  'no Data API role holds a column-level INSERT or UPDATE on profiles'
);
select ok(has_table_privilege('authenticated', 'public.profiles', 'SELECT'), 'an account still reads its own profile');
select ok(has_table_privilege('service_role', 'public.profiles', 'UPDATE'), 'the API (service role) still saves profiles');

-- created_at is explicit: auth.users has no default for it.
insert into auth.users (id, email, aud, role, is_anonymous, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
  ('9f100000-0000-4000-8000-000000000001'::uuid, 'profile-writer@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb);
insert into public.profiles (id) values ('9f100000-0000-4000-8000-000000000001'::uuid) on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9f100000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select throws_ok(
  $$update public.profiles set username = 'support' where id = '9f100000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'an account cannot take a reserved handle by writing its own row'
);
select throws_ok(
  $$update public.profiles set website_url = 'javascript:alert(1)', bio = repeat('x', 100000) where id = '9f100000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'an account cannot set its website or bio past the API'
);

reset role;
select * from finish();
rollback;
