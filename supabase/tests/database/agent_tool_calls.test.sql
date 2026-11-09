-- The MCP server's audit ledger: owner-read under RLS, appended by the service role alone, never
-- updated or deleted through any Data API role, gone with its account.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(23);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.agent_tool_calls'::regclass),
  'agent_tool_calls has row-level security enabled'
);
select ok(
  exists (
    select 1 from pg_policy
    where polrelid = 'public.agent_tool_calls'::regclass
      and polname = 'authenticated_identity_active'
      and not polpermissive
  ),
  'the identity-state restrictive policy every authenticated grant carries is on the ledger'
);

select has_index('public', 'agent_tool_calls', 'agent_tool_calls_user_created_idx', 'the owner read is indexed by user and time');
select has_index('public', 'agent_tool_calls', 'agent_tool_calls_post_idx', 'the moderation join is indexed by post');

-- Privileges: the owner reads, the service role appends, nobody changes or removes a row.
select ok(has_table_privilege('authenticated', 'public.agent_tool_calls', 'SELECT'), 'authenticated may read (RLS narrows it to their own rows)');
select ok(not has_table_privilege('authenticated', 'public.agent_tool_calls', 'INSERT'), 'authenticated cannot write audit rows');
select ok(not has_table_privilege('authenticated', 'public.agent_tool_calls', 'UPDATE'), 'authenticated cannot change audit rows');
select ok(not has_table_privilege('authenticated', 'public.agent_tool_calls', 'DELETE'), 'authenticated cannot delete audit rows');
select ok(not has_table_privilege('anon', 'public.agent_tool_calls', 'SELECT'), 'anon cannot read audit rows');
select ok(not has_table_privilege('anon', 'public.agent_tool_calls', 'INSERT'), 'anon cannot write audit rows');
select ok(has_table_privilege('service_role', 'public.agent_tool_calls', 'SELECT'), 'the service role reads the ledger for moderation');
select ok(has_table_privilege('service_role', 'public.agent_tool_calls', 'INSERT'), 'the service role appends the ledger');
select ok(not has_table_privilege('service_role', 'public.agent_tool_calls', 'UPDATE'), 'the ledger is append-only: no update for the service role');
select ok(not has_table_privilege('service_role', 'public.agent_tool_calls', 'DELETE'), 'the ledger is append-only: no delete for the service role');

-- created_at is explicit: auth.users has no default for it.
insert into auth.users (id, email, aud, role, is_anonymous, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
  ('ac100000-0000-4000-8000-000000000001'::uuid, 'agent-owner@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('ac200000-0000-4000-8000-000000000002'::uuid, 'agent-other@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb);

insert into public.agent_tool_calls (user_id, client_id, tool, ok, code, generation_id, post_id, cost_credits) values
  ('ac100000-0000-4000-8000-000000000001', 'client-claude', 'create_media', true, null, 'bc100000-0000-4000-8000-000000000001', null, 19),
  ('ac100000-0000-4000-8000-000000000001', 'client-claude', 'publish_post', true, null, 'bc100000-0000-4000-8000-000000000001', 'cc100000-0000-4000-8000-000000000001', null),
  ('ac100000-0000-4000-8000-000000000001', 'client-claude', 'publish_post', false, 'RATE_LIMITED', 'bc100000-0000-4000-8000-000000000002', null, null),
  ('ac200000-0000-4000-8000-000000000002', 'client-codex', 'list_models', true, null, null, null, null);

select throws_ok(
  $$insert into public.agent_tool_calls (user_id, client_id, tool, ok, cost_credits)
    values ('ac100000-0000-4000-8000-000000000001', 'client-claude', 'create_media', true, -1)$$,
  '23514',
  null,
  'a negative cost is refused'
);
select throws_ok(
  $$insert into public.agent_tool_calls (user_id, client_id, tool, ok) values ('ac100000-0000-4000-8000-000000000001', '', 'create_media', true)$$,
  '23514',
  null,
  'an empty client id is refused'
);

-- The owner sees their own rows and nobody else's.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ac100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.agent_tool_calls),
  3,
  'an owner reads exactly their own rows'
);
select is(
  (select count(*)::int from public.agent_tool_calls where post_id = 'cc100000-0000-4000-8000-000000000001'),
  1,
  'an owner finds the row that names their post'
);
select set_config('request.jwt.claims', '{"sub":"ac200000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.agent_tool_calls),
  1,
  'another account reads only its own row'
);
select throws_ok(
  $$insert into public.agent_tool_calls (user_id, client_id, tool, ok)
    values ('ac200000-0000-4000-8000-000000000002', 'client-codex', 'list_models', true)$$,
  '42501',
  null,
  'an account cannot write its own audit row'
);
select throws_ok(
  $$delete from public.agent_tool_calls$$,
  '42501',
  null,
  'an account cannot delete audit rows'
);
reset role;

-- An account being deleted sees nothing through a token it still holds.
update public.profiles set identity_state = 'deleting' where id = 'ac100000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ac100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.agent_tool_calls),
  0,
  'a deleting account reads none of its rows'
);
-- Not set back: a deleting identity cannot be reactivated (the trigger refuses), and the
-- transaction rolls back at the end.
reset role;

-- The ledger goes with its account.
delete from auth.users where id = 'ac200000-0000-4000-8000-000000000002';
select is(
  (select count(*)::int from public.agent_tool_calls where user_id = 'ac200000-0000-4000-8000-000000000002'),
  0,
  'deleting the account removes its audit rows'
);

select * from finish();
rollback;
