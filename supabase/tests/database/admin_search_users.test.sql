begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(21);

select ok(to_regprocedure('public.admin_search_users(text,text,integer,integer)') is not null, 'admin user search RPC exists');
select ok(not has_function_privilege('anon','public.admin_search_users(text,text,integer,integer)','EXECUTE'), 'anonymous cannot list accounts');
select ok(not has_function_privilege('authenticated','public.admin_search_users(text,text,integer,integer)','EXECUTE'), 'a signed-in client cannot list accounts');
select ok(has_function_privilege('service_role','public.admin_search_users(text,text,integer,integer)','EXECUTE'), 'the console''s service role can list accounts');
select ok((select prosecdef from pg_proc where oid='public.admin_search_users(text,text,integer,integer)'::regprocedure), 'reads auth.users as its definer');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.admin_search_users(text,text,integer,integer)'::regprocedure), 'definer search path is fixed');

set local role anon;
select throws_ok($$select * from public.admin_search_users()$$, '42501', null, 'anonymous execution is denied');
reset role;

-- A registered account and two guests whose names share a probe word. The
-- profile trigger makes each profile; the names are set after.
insert into auth.users(id,email,aud,role,is_anonymous,created_at) values
  ('a5e10001-0000-4000-8000-000000000001','kindprobe-registered@audit.invalid','authenticated','authenticated',false,now() - interval '3 minutes'),
  ('a5e10002-0000-4000-8000-000000000002',null,'authenticated','authenticated',true,now() - interval '2 minutes'),
  ('a5e10003-0000-4000-8000-000000000003',null,'authenticated','authenticated',true,now() - interval '1 minute');
update public.profiles set username = 'kindprobe-a1', display_name = 'Kindprobe_Account'
  where id = 'a5e10001-0000-4000-8000-000000000001';
update public.profiles set display_name = 'Kindprobe guest'
  where id in ('a5e10002-0000-4000-8000-000000000002','a5e10003-0000-4000-8000-000000000003');

select is(
  (select array_agg(id::text order by id) from public.admin_search_users('kindprobe','registered',25,0)),
  array['a5e10001-0000-4000-8000-000000000001'],
  'registered lists the account and no guest'
);
select is(
  (select array_agg(id::text order by id) from public.admin_search_users('kindprobe','guests',25,0)),
  array['a5e10002-0000-4000-8000-000000000002','a5e10003-0000-4000-8000-000000000003'],
  'guests lists the guests and not the account'
);
select is(
  (select array_agg(is_guest order by id) from public.admin_search_users('kindprobe','all',25,0)),
  array[false,true,true],
  'all lists every one, saying which are guests'
);
select is(
  (select max(total_count) from public.admin_search_users('kindprobe','all',1,0)),
  3::bigint,
  'the total counts every match, not just the page'
);
select is(
  (select array_agg(id::text) from public.admin_search_users('kindprobe','all',1,1)),
  array['a5e10002-0000-4000-8000-000000000002'],
  'pages newest first by the offset'
);
select is(
  (select count(*) from public.admin_search_users('kindprobe','all',25,99)),
  0::bigint,
  'a page past the end is empty'
);
select is(
  (select array_agg(id::text) from public.admin_search_users('A5E10003-0000-4000-8000-000000000003','all',25,0)),
  array['a5e10003-0000-4000-8000-000000000003'],
  'a user id finds that one identity'
);
-- Unescaped, '_' is any one character and 'kindprobe_' would match "Kindprobe guest".
select is(
  (select array_agg(id::text) from public.admin_search_users('kindprobe_','all',25,0)),
  array['a5e10001-0000-4000-8000-000000000001'],
  'an underscore in the term is a letter, not a wildcard'
);
-- Unescaped, '%' is any run of characters and 'kindprobe%guest' would match "Kindprobe guest".
select is(
  (select count(*) from public.admin_search_users('kindprobe%guest','all',25,0)),
  0::bigint,
  'a percent sign in the term is a letter, not a wildcard'
);
-- Unescaped, a trailing backslash would end the pattern on its escape character.
select lives_ok(
  $$select * from public.admin_search_users('kindprobe\','all',25,0)$$,
  'a trailing backslash in the term is a letter, not an error'
);
select is(
  (select count(*) from public.admin_search_users('kindprobe\','all',25,0)),
  0::bigint,
  'a trailing backslash matches only itself'
);
-- With neither a term nor a kind, the list is registered accounts: the
-- fixtures are the newest profiles, so the first page holds all three.
select ok(
  (select bool_and(not is_guest) from public.admin_search_users()),
  'the default list holds no guest'
);
select ok(
  'a5e10001-0000-4000-8000-000000000001'::uuid in (select id from public.admin_search_users()),
  'the default list holds the newest account'
);
select throws_ok(
  $$select * from public.admin_search_users(null,'everyone',25,0)$$,
  '22023', null, 'an unknown kind is refused'
);

select * from finish();
rollback;
