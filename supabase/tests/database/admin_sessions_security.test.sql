-- The admin cookie is only an edge admission hint. This table is the
-- authoritative revocation boundary and must never be reachable through the
-- anon or authenticated Data API roles.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(23);

select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'public.admin_sessions'::regclass),
  'admin_sessions has row-level security enabled'
);

select ok(not has_table_privilege('authenticated', 'public.admin_sessions', 'SELECT'),
  'authenticated cannot read admin sessions');
select ok(not has_table_privilege('authenticated', 'public.admin_sessions', 'INSERT'),
  'authenticated cannot create admin sessions');
select ok(not has_table_privilege('authenticated', 'public.admin_sessions', 'UPDATE'),
  'authenticated cannot revoke or alter admin sessions');
select ok(not has_table_privilege('authenticated', 'public.admin_sessions', 'DELETE'),
  'authenticated cannot delete admin sessions');

select ok(not has_table_privilege('anon', 'public.admin_sessions', 'SELECT'),
  'anon cannot read admin sessions');
select ok(not has_table_privilege('anon', 'public.admin_sessions', 'INSERT'),
  'anon cannot create admin sessions');
select ok(not has_table_privilege('anon', 'public.admin_sessions', 'UPDATE'),
  'anon cannot revoke or alter admin sessions');
select ok(not has_table_privilege('anon', 'public.admin_sessions', 'DELETE'),
  'anon cannot delete admin sessions');

select ok(has_table_privilege('service_role', 'public.admin_sessions', 'SELECT'),
  'service role can read authoritative admin sessions');
select ok(has_table_privilege('service_role', 'public.admin_sessions', 'INSERT'),
  'service role can create authoritative admin sessions');
select ok(has_table_privilege('service_role', 'public.admin_sessions', 'UPDATE'),
  'service role can revoke authoritative admin sessions');
select ok(has_table_privilege('service_role', 'public.admin_sessions', 'DELETE'),
  'service role can delete expired admin sessions');

set local role authenticated;
select throws_ok(
  $$select session_id from public.admin_sessions$$,
  '42501',
  null,
  'authenticated SELECT is denied by database privileges'
);
select throws_ok(
  $$insert into public.admin_sessions (
      session_id, subject, credential_version, expires_at
    ) values (
      'aa000000-0000-4000-8000-000000000001'::uuid,
      'forged',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      now() + interval '1 hour'
    )$$,
  '42501',
  null,
  'authenticated INSERT is denied by database privileges'
);

reset role;
set local role anon;
select throws_ok(
  $$select session_id from public.admin_sessions$$,
  '42501',
  null,
  'anonymous SELECT is denied by database privileges'
);
select throws_ok(
  $$insert into public.admin_sessions (
      session_id, subject, credential_version, expires_at
    ) values (
      'aa000000-0000-4000-8000-000000000002'::uuid,
      'forged',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      now() + interval '1 hour'
    )$$,
  '42501',
  null,
  'anonymous INSERT is denied by database privileges'
);

reset role;
set local role service_role;
select lives_ok(
  $$insert into public.admin_sessions (
      session_id, subject, credential_version, expires_at
    ) values (
      'aa000000-0000-4000-8000-000000000003'::uuid,
      'master',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      now() + interval '1 hour'
    )$$,
  'service role can create an authoritative session row'
);
select is(
  (select count(*) from public.admin_sessions
   where session_id = 'aa000000-0000-4000-8000-000000000003'::uuid),
  1::bigint,
  'service role can read the created session row'
);
select lives_ok(
  $$update public.admin_sessions
    set revoked_at = now()
    where session_id = 'aa000000-0000-4000-8000-000000000003'::uuid$$,
  'service role can revoke a session row'
);
select is(
  (select revoked_at is not null from public.admin_sessions
   where session_id = 'aa000000-0000-4000-8000-000000000003'::uuid),
  true,
  'the service-role revocation is persisted'
);
select lives_ok(
  $$delete from public.admin_sessions
    where session_id = 'aa000000-0000-4000-8000-000000000003'::uuid$$,
  'service role can delete an expired or revoked session row'
);
select is(
  (select count(*) from public.admin_sessions
   where session_id = 'aa000000-0000-4000-8000-000000000003'::uuid),
  0::bigint,
  'the service-role deletion removes the session row'
);

reset role;

select * from finish();
rollback;
