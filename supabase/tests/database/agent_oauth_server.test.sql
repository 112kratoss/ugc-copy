-- The app's own authorization server for MCP (migration 20261126121704): the tables are the
-- service role's alone; a code is spent once and its replay ends the grant; a refresh token
-- rotates and its reuse past the grace ends the grant; a token admits only while its grant, its
-- client and its account stand.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(95);

-- ---------------------------------------------------------------------------------------------
-- Privileges

select ok((select relrowsecurity from pg_class where oid = 'public.agent_oauth_clients'::regclass), 'agent_oauth_clients has row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.agent_oauth_grants'::regclass), 'agent_oauth_grants has row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.agent_oauth_authorizations'::regclass), 'agent_oauth_authorizations has row-level security enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.agent_oauth_tokens'::regclass), 'agent_oauth_tokens has row-level security enabled');

select is(
  (select count(*)::int from pg_policy where polrelid in (
    'public.agent_oauth_clients'::regclass, 'public.agent_oauth_grants'::regclass,
    'public.agent_oauth_authorizations'::regclass, 'public.agent_oauth_tokens'::regclass)),
  0,
  'no policy opens any of the four tables to a Data API role'
);

select is(
  (select count(*)::int
     from unnest(array['agent_oauth_clients', 'agent_oauth_grants', 'agent_oauth_authorizations', 'agent_oauth_tokens']) as t(name),
          unnest(array['anon', 'authenticated']) as r(name),
          unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(name)
    where has_table_privilege(r.name, 'public.' || t.name, p.name)),
  0,
  'anon and authenticated hold no privilege on any of the four tables'
);

select ok(has_table_privilege('service_role', 'public.agent_oauth_clients', 'SELECT'), 'the service role reads clients');
select ok(has_table_privilege('service_role', 'public.agent_oauth_clients', 'INSERT'), 'the service role registers clients');
select ok(has_table_privilege('service_role', 'public.agent_oauth_clients', 'UPDATE'), 'the service role disables a client and replaces its secret');
select ok(not has_table_privilege('service_role', 'public.agent_oauth_clients', 'DELETE'), 'a client is disabled, never deleted, through the Data API');
select ok(has_table_privilege('service_role', 'public.agent_oauth_grants', 'SELECT'), 'the service role lists grants');
select ok(not has_table_privilege('service_role', 'public.agent_oauth_grants', 'INSERT'), 'a grant is made only by agent_oauth_issue_grant');
select ok(not has_table_privilege('service_role', 'public.agent_oauth_grants', 'UPDATE'), 'a grant is revoked only by the revoke functions');
select ok(has_table_privilege('service_role', 'public.agent_oauth_authorizations', 'UPDATE'), 'the service role records the answer to a request');
select ok(not has_table_privilege('service_role', 'public.agent_oauth_authorizations', 'DELETE'), 'requests are purged only by agent_oauth_purge_expired');
select is(
  (select count(*)::int from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(name)
    where has_table_privilege('service_role', 'public.agent_oauth_tokens', p.name)),
  0,
  'token hashes are read and written only by the functions'
);

select is(
  (select count(*)::int
     from pg_proc as fn
     cross join unnest(array['anon', 'authenticated']) as r(name)
    where fn.pronamespace = 'public'::regnamespace
      and fn.proname like 'agent_oauth_%'
      and has_function_privilege(r.name, fn.oid, 'EXECUTE')),
  0,
  'anon and authenticated can execute none of the agent_oauth functions'
);
select is(
  (select count(*)::int from pg_proc as fn
    where fn.pronamespace = 'public'::regnamespace and fn.proname like 'agent_oauth_%'
      and has_function_privilege('service_role', fn.oid, 'EXECUTE')),
  12,
  'the service role can execute all twelve: the nine that change state and the three pure checks of 20261126151150'
);
select is(
  (select count(*)::int from pg_proc as fn
    where fn.pronamespace = 'public'::regnamespace and fn.proname like 'agent_oauth_%'
      and (fn.proconfig is null or not ('search_path=""' = any (fn.proconfig))
           or (not fn.prosecdef and fn.proname not in (
             'agent_oauth_redirect_uri_ok', 'agent_oauth_redirect_uris_ok', 'agent_oauth_credential_fingerprint')))),
  0,
  'every one has an empty search_path, and all but the three pure checks are definers'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"ad100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok($$select * from public.agent_oauth_tokens$$, '42501', null, 'a signed-in account cannot read token hashes');
select throws_ok($$select * from public.agent_oauth_clients$$, '42501', null, 'a signed-in account cannot read clients, a secret hash among them');
select throws_ok($$select public.agent_oauth_token_admission('x')$$, '42501', null, 'a signed-in account cannot ask for an admission');
select throws_ok(
  $$select public.agent_oauth_revoke_grants('ad100000-0000-4000-8000-000000000001', 'client-full', 'user')$$,
  '42501', null, 'a signed-in account cannot call the revoke function directly'
);
reset role;

-- ---------------------------------------------------------------------------------------------
-- Fixtures. created_at is explicit: auth.users has no default for it.

insert into auth.users (id, email, aud, role, is_anonymous, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
  ('ad100000-0000-4000-8000-000000000001'::uuid, 'oauth-owner@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('ad200000-0000-4000-8000-000000000002'::uuid, 'oauth-other@example.invalid', 'authenticated', 'authenticated', false,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('ad300000-0000-4000-8000-000000000003'::uuid, null, 'authenticated', 'authenticated', true,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb);

insert into public.agent_oauth_clients (client_id, client_name, redirect_uris, surface) values
  ('client-full', 'Full client', array['http://localhost:8976/callback'], 'full'),
  ('client-posts', 'Posting client', array['https://claude.ai/api/mcp/auth_callback'], 'posts');

select throws_ok(
  $$insert into public.agent_oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method)
    values ('client-nosecret', 'No secret', array['https://x.test/cb'], 'client_secret_post')$$,
  '23514', null, 'a confidential client must have a secret hash'
);
select throws_ok(
  $$insert into public.agent_oauth_clients (client_id, client_name, redirect_uris, client_secret_hash)
    values ('client-extra', 'Extra secret', array['https://x.test/cb'], repeat('a', 43))$$,
  '23514', null, 'a public client must have none'
);
select throws_ok(
  $$insert into public.agent_oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, client_secret_hash)
    values ('client-plain', 'Plain secret', array['https://x.test/cb'], 'client_secret_post', 'a-secret-in-the-clear')$$,
  '23514', null, 'a secret that is not a 43-character digest is refused'
);
select throws_ok(
  $$insert into public.agent_oauth_clients (client_id, client_name, redirect_uris) values ('client-nouri', 'No redirect', array[]::text[])$$,
  '23514', null, 'a client needs a redirect URI'
);

-- A pending request, shown to the owner and approved, with its code's hash.
insert into public.agent_oauth_authorizations
  (id, client_id, redirect_uri, surface, state, code_challenge, user_id, status, code_hash, code_expires_at, expires_at)
values
  ('mbar_' || repeat('a', 43), 'client-full', 'http://localhost:8976/callback', 'full', 'st', repeat('c', 43),
   'ad100000-0000-4000-8000-000000000001', 'approved', repeat('1', 43), now() + interval '2 minutes', now() + interval '10 minutes'),
  ('mbar_' || repeat('b', 43), 'client-full', 'http://localhost:8976/callback', 'full', null, repeat('c', 43),
   'ad100000-0000-4000-8000-000000000001', 'approved', repeat('2', 43), now() - interval '1 second', now() + interval '10 minutes'),
  ('mbar_' || repeat('c', 43), 'client-posts', 'https://claude.ai/api/mcp/auth_callback', 'posts', null, repeat('c', 43),
   'ad200000-0000-4000-8000-000000000002', 'approved', repeat('3', 43), now() + interval '2 minutes', now() + interval '10 minutes'),
  ('mbar_' || repeat('d', 43), 'client-full', 'http://localhost:8976/callback', 'full', null, repeat('c', 43),
   null, 'pending', null, null, now() + interval '10 minutes'),
  ('mbar_' || repeat('e', 43), 'client-full', 'http://localhost:8976/callback', 'full', null, repeat('c', 43),
   'ad300000-0000-4000-8000-000000000003', 'approved', repeat('5', 43), now() + interval '2 minutes', now() + interval '10 minutes');

select throws_ok(
  $$insert into public.agent_oauth_authorizations (id, client_id, redirect_uri, surface, code_challenge, status, expires_at)
    values ('mbar_' || repeat('z', 43), 'client-full', 'http://localhost:8976/callback', 'full', repeat('c', 43), 'approved', now())$$,
  '23514', null, 'a request cannot be answered before it is bound to an account'
);
select throws_ok(
  $$insert into public.agent_oauth_authorizations (id, client_id, redirect_uri, surface, code_challenge, expires_at)
    values ('gotrue-style-id', 'client-full', 'http://localhost:8976/callback', 'full', repeat('c', 43), now())$$,
  '23514', null, 'a request id has the server''s own shape'
);

-- ---------------------------------------------------------------------------------------------
-- A code is spent once

select is(public.agent_oauth_consume_code(repeat('9', 43)) ->> 'outcome', 'invalid', 'an unknown code is invalid');
select is(public.agent_oauth_consume_code(repeat('2', 43)) ->> 'outcome', 'invalid', 'an expired code is invalid');
select is(
  (select status from public.agent_oauth_authorizations where id = 'mbar_' || repeat('b', 43)),
  'approved',
  'and is not marked consumed'
);

select is(
  public.agent_oauth_consume_code(repeat('1', 43)),
  jsonb_build_object(
    'outcome', 'consumed',
    'authorization_id', 'mbar_' || repeat('a', 43),
    'client_id', 'client-full',
    'redirect_uri', 'http://localhost:8976/callback',
    'code_challenge', repeat('c', 43),
    'surface', 'full',
    'user_id', 'ad100000-0000-4000-8000-000000000001'
  ),
  'a live code is consumed and answers what the token endpoint checks'
);

select is(
  public.agent_oauth_issue_grant('mbar_' || repeat('d', 43), repeat('x', 43), repeat('y', 43), 3600, 7776000) ->> 'outcome',
  'invalid',
  'no grant is issued for a request whose code was never consumed'
);
select throws_ok(
  $$select public.agent_oauth_issue_grant('mbar_' || repeat('a', 43), repeat('A', 43), repeat('R', 43), 0, 7776000)$$,
  'P0001', null, 'a token lifetime must be positive'
);

select is(
  public.agent_oauth_issue_grant('mbar_' || repeat('a', 43), repeat('A', 43), repeat('R', 43), 3600, 7776000) ->> 'outcome',
  'issued',
  'the consumed request gets its grant and first token pair'
);
select is((select count(*)::int from public.agent_oauth_grants where user_id = 'ad100000-0000-4000-8000-000000000001' and client_id = 'client-full' and surface = 'full' and revoked_at is null), 1, 'one live grant, for the account, the client and the server asked');
select is((select count(*)::int from public.agent_oauth_tokens where kind = 'access' and token_hash = repeat('A', 43) and expires_at = now() + interval '1 hour'), 1, 'the access token''s hash, good for the hour asked');
select is((select count(*)::int from public.agent_oauth_tokens where kind = 'refresh' and token_hash = repeat('R', 43) and expires_at = now() + interval '90 days'), 1, 'the refresh token''s hash, good for the ninety days asked');
select is(
  public.agent_oauth_issue_grant('mbar_' || repeat('a', 43), repeat('B', 43), repeat('S', 43), 3600, 7776000) ->> 'outcome',
  'invalid',
  'a request is given one grant, never a second'
);

-- ---------------------------------------------------------------------------------------------
-- Admission

select is(
  public.agent_oauth_token_admission(repeat('A', 43)) - 'grant_id' - 'created_at',
  jsonb_build_object(
    'user_id', 'ad100000-0000-4000-8000-000000000001',
    'client_id', 'client-full',
    'surface', 'full',
    'state', 'active',
    'email', 'oauth-owner@example.invalid',
    'is_anonymous', false,
    'banned', false
  ),
  'a live access token admits its account, with the lifecycle answers admission needs'
);
select ok(
  (select last_used_at is not null from public.agent_oauth_grants where client_id = 'client-full' and user_id = 'ad100000-0000-4000-8000-000000000001'),
  'and marks the grant used'
);
select is(public.agent_oauth_token_admission(repeat('R', 43)), null, 'a refresh token admits nobody');
select is(public.agent_oauth_token_admission(repeat('Q', 43)), null, 'an unknown token admits nobody');

update auth.users set banned_until = now() + interval '1 hour' where id = 'ad100000-0000-4000-8000-000000000001';
select is((public.agent_oauth_token_admission(repeat('A', 43)) ->> 'banned')::boolean, true, 'a banned account is said to be banned');
update auth.users set banned_until = null where id = 'ad100000-0000-4000-8000-000000000001';

update public.agent_oauth_clients set disabled_at = now() where client_id = 'client-full';
select is(public.agent_oauth_token_admission(repeat('A', 43)), null, 'a disabled client''s tokens admit nobody');
select is(
  public.agent_oauth_rotate_refresh_token(repeat('R', 43), 'client-full', repeat('C', 43), repeat('T', 43), 3600, 7776000, 10) ->> 'outcome',
  'invalid',
  'and its refresh tokens renew nothing'
);
update public.agent_oauth_clients set disabled_at = null where client_id = 'client-full';

update public.agent_oauth_tokens set expires_at = now() - interval '1 second' where token_hash = repeat('A', 43);
select is(public.agent_oauth_token_admission(repeat('A', 43)), null, 'an expired access token admits nobody');
update public.agent_oauth_tokens set expires_at = now() + interval '1 hour' where token_hash = repeat('A', 43);

-- A guest, should one ever hold a grant: admission says so and the route refuses it.
select is(public.agent_oauth_consume_code(repeat('5', 43)) ->> 'outcome', 'consumed', 'a guest''s code, for the backstop below');
select is(public.agent_oauth_issue_grant('mbar_' || repeat('e', 43), repeat('G', 43), repeat('H', 43), 3600, 7776000) ->> 'outcome', 'issued', 'and its grant');
select is((public.agent_oauth_token_admission(repeat('G', 43)) ->> 'is_anonymous')::boolean, true, 'a guest is said to be a guest');

-- ---------------------------------------------------------------------------------------------
-- Refresh rotation and reuse

select is(
  public.agent_oauth_rotate_refresh_token(repeat('R', 43), 'client-posts', repeat('C', 43), repeat('T', 43), 3600, 7776000, 10) ->> 'outcome',
  'invalid',
  'another client cannot rotate the token'
);
select is((select used_at from public.agent_oauth_tokens where token_hash = repeat('R', 43)), null, 'and does not mark it used');
select is(
  public.agent_oauth_rotate_refresh_token(repeat('A', 43), 'client-full', repeat('C', 43), repeat('T', 43), 3600, 7776000, 10) ->> 'outcome',
  'invalid',
  'an access token is not a refresh token'
);

select is(
  public.agent_oauth_rotate_refresh_token(repeat('R', 43), 'client-full', repeat('C', 43), repeat('T', 43), 3600, 7776000, 10) ->> 'outcome',
  'rotated',
  'the client''s own refresh token rotates'
);
select ok((select used_at is not null from public.agent_oauth_tokens where token_hash = repeat('R', 43)), 'the old refresh token is marked used, and kept');
select is((select count(*)::int from public.agent_oauth_tokens where token_hash in (repeat('C', 43), repeat('T', 43))), 2, 'a new access and refresh hash are stored');
select ok(public.agent_oauth_token_admission(repeat('C', 43)) is not null, 'the new access token admits');
select ok(public.agent_oauth_token_admission(repeat('A', 43)) is not null, 'the earlier access token still admits until it expires');

select is(
  public.agent_oauth_rotate_refresh_token(repeat('R', 43), 'client-full', repeat('D', 43), repeat('U', 43), 3600, 7776000, 10) ->> 'outcome',
  'rotated',
  'a second use inside the grace gets another pair'
);

update public.agent_oauth_tokens set used_at = now() - interval '11 seconds' where token_hash = repeat('R', 43);
select is(
  public.agent_oauth_rotate_refresh_token(repeat('R', 43), 'client-full', repeat('E', 43), repeat('V', 43), 3600, 7776000, 10) ->> 'outcome',
  'reuse_detected',
  'a use after the grace is reuse'
);
select is(
  (select revoked_reason from public.agent_oauth_grants where client_id = 'client-full' and user_id = 'ad100000-0000-4000-8000-000000000001'),
  'reuse',
  'which revokes the grant'
);
select is(
  (select count(*)::int from public.agent_oauth_tokens as token
     join public.agent_oauth_grants as grant_row on grant_row.id = token.grant_id
    where grant_row.client_id = 'client-full' and grant_row.user_id = 'ad100000-0000-4000-8000-000000000001'),
  0,
  'and deletes every token under it'
);
select is(public.agent_oauth_token_admission(repeat('C', 43)), null, 'so the newest access token admits nobody');
select is(
  public.agent_oauth_rotate_refresh_token(repeat('U', 43), 'client-full', repeat('F', 43), repeat('W', 43), 3600, 7776000, 10) ->> 'outcome',
  'invalid',
  'and the newest refresh token renews nothing'
);

-- ---------------------------------------------------------------------------------------------
-- A replayed code, and revocation

select is(public.agent_oauth_consume_code(repeat('3', 43)) ->> 'outcome', 'consumed', 'the other account''s code is consumed');
select is(public.agent_oauth_issue_grant('mbar_' || repeat('c', 43), repeat('J', 43), repeat('K', 43), 3600, 7776000) ->> 'outcome', 'issued', 'and its posting grant issued');
select is(public.agent_oauth_token_admission(repeat('J', 43)) ->> 'surface', 'posts', 'whose token says it is for the posting server');
select is(public.agent_oauth_consume_code(repeat('3', 43)) ->> 'outcome', 'replayed', 'the same code presented again is a replay');
select is(
  (select revoked_reason from public.agent_oauth_grants where user_id = 'ad200000-0000-4000-8000-000000000002'),
  'code_replay',
  'which revokes the grant the code produced'
);
select is(public.agent_oauth_token_admission(repeat('J', 43)), null, 'and its token admits nobody');

select is(public.agent_oauth_revoke_token(repeat('G', 43), 'client-posts'), false, 'a client cannot revoke another client''s token');
select ok(public.agent_oauth_token_admission(repeat('G', 43)) is not null, 'which goes on admitting');
select is(public.agent_oauth_revoke_grants('ad200000-0000-4000-8000-000000000002', 'client-full', 'user'), 0, 'an account cannot end another account''s grant');
select is(public.agent_oauth_revoke_grants('ad300000-0000-4000-8000-000000000003', 'client-full', 'user'), 1, 'an account ends its own grant to a client');
select is(public.agent_oauth_token_admission(repeat('G', 43)), null, 'and the token admits nobody at once');
select is(public.agent_oauth_revoke_grants('ad300000-0000-4000-8000-000000000003', 'client-full', 'user'), 0, 'ending it again ends nothing');
select throws_ok(
  $$update public.agent_oauth_grants set revoked_reason = 'because' where user_id = 'ad300000-0000-4000-8000-000000000003'$$,
  '23514', null, 'a revocation names one of the known reasons'
);

-- With no client named: every live grant of the account, and nobody else's.
-- The fixture accounts have no password, so each grant carries the fingerprint of none (20261126151150).
insert into public.agent_oauth_grants (id, user_id, client_id, surface, credential_fingerprint) values
  ('ae100000-0000-4000-8000-000000000001', 'ad300000-0000-4000-8000-000000000003', 'client-full', 'full', public.agent_oauth_credential_fingerprint(null)),
  ('ae200000-0000-4000-8000-000000000002', 'ad300000-0000-4000-8000-000000000003', 'client-posts', 'posts', public.agent_oauth_credential_fingerprint(null)),
  ('ae300000-0000-4000-8000-000000000003', 'ad200000-0000-4000-8000-000000000002', 'client-full', 'full', public.agent_oauth_credential_fingerprint(null));
insert into public.agent_oauth_tokens (token_hash, kind, grant_id, expires_at) values
  (repeat('L', 43), 'access', 'ae100000-0000-4000-8000-000000000001', now() + interval '1 hour'),
  (repeat('M', 43), 'refresh', 'ae200000-0000-4000-8000-000000000002', now() + interval '90 days'),
  (repeat('N', 43), 'access', 'ae300000-0000-4000-8000-000000000003', now() + interval '1 hour');
select is(public.agent_oauth_revoke_grants('ad300000-0000-4000-8000-000000000003', null, 'user'), 2, 'with no client named, every live grant of the account ends');
select is((select count(*)::int from public.agent_oauth_tokens where token_hash in (repeat('L', 43), repeat('M', 43))), 0, 'with every token under them');
select ok(public.agent_oauth_token_admission(repeat('N', 43)) is not null, 'and another account''s grant goes on');

-- A request approved but not yet exchanged ends with a Disconnect, and so does one only shown.
insert into public.agent_oauth_authorizations
  (id, client_id, redirect_uri, surface, code_challenge, user_id, status, code_hash, code_expires_at, expires_at)
values
  ('mbar_' || repeat('f', 43), 'client-full', 'http://localhost:8976/callback', 'full', repeat('c', 43),
   'ad200000-0000-4000-8000-000000000002', 'approved', repeat('6', 43), now() + interval '2 minutes', now() + interval '10 minutes'),
  ('mbar_' || repeat('g', 43), 'client-posts', 'https://claude.ai/api/mcp/auth_callback', 'posts', repeat('c', 43),
   'ad200000-0000-4000-8000-000000000002', 'approved', repeat('7', 43), now() + interval '2 minutes', now() + interval '10 minutes'),
  ('mbar_' || repeat('h', 43), 'client-full', 'http://localhost:8976/callback', 'full', repeat('c', 43),
   'ad200000-0000-4000-8000-000000000002', 'pending', null, null, now() + interval '10 minutes');
select is(public.agent_oauth_revoke_grants('ad200000-0000-4000-8000-000000000002', 'client-full', 'user'), 1, 'a Disconnect ends the account''s live grant to the client');
select is(public.agent_oauth_consume_code(repeat('6', 43)) ->> 'outcome', 'invalid', 'and the code that client was just given buys nothing');
select is((select status from public.agent_oauth_authorizations where id = 'mbar_' || repeat('h', 43)), 'denied', 'a request only shown is closed too');
select is((select status from public.agent_oauth_authorizations where id = 'mbar_' || repeat('g', 43)), 'approved', 'another client''s request is left alone');

-- A code presented twice before its grant exists: the request is closed and no grant is issued.
select is(public.agent_oauth_consume_code(repeat('7', 43)) ->> 'outcome', 'consumed', 'a code is consumed');
select is(public.agent_oauth_consume_code(repeat('7', 43)) ->> 'outcome', 'replayed', 'and presented again before its grant is issued');
select is(
  public.agent_oauth_issue_grant('mbar_' || repeat('g', 43), repeat('X', 43), repeat('Y', 43), 3600, 7776000) ->> 'outcome',
  'invalid',
  'so no grant is issued for it'
);

-- ---------------------------------------------------------------------------------------------
-- The cutover's import, against Supabase Auth's own table where the stack has one (a Postgres-only
-- replay, as CI's, has no GoTrue and so no auth.oauth_clients: the function then says so).

-- "Present" means the table in the shape GoTrue v2.186 gives it, which the fixture rows need.
create temporary table import_fixture on commit drop as
  select to_regclass('auth.oauth_clients') is not null
     and (select count(*) from information_schema.columns
           where table_schema = 'auth' and table_name = 'oauth_clients'
             and column_name in ('id', 'client_secret_hash', 'registration_type', 'redirect_uris', 'grant_types',
                                 'client_name', 'client_uri', 'client_type', 'token_endpoint_auth_method', 'deleted_at')) = 10
     as present;
do $fixture$
begin
  if (select present from import_fixture) then
    execute $sql$
      insert into auth.oauth_clients
        (id, client_secret_hash, registration_type, redirect_uris, grant_types, client_name, client_uri, client_type, token_endpoint_auth_method)
      values
        ('af100000-0000-4000-8000-000000000001', null, 'manual', 'http://localhost:8976/callback', 'authorization_code,refresh_token', 'Imported public', 'https://claude.com/claude-code', 'public', 'none'),
        ('af200000-0000-4000-8000-000000000002', repeat('s', 43), 'manual', 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback', 'authorization_code,refresh_token', 'Imported directory', null, 'confidential', 'client_secret_post'),
        ('af300000-0000-4000-8000-000000000003', '$2a$10$notTheFormThisServerKeeps', 'manual', 'https://x.test/cb', 'authorization_code,refresh_token', 'Imported other hash', null, 'confidential', 'client_secret_post')
    $sql$;
  end if;
end;
$fixture$;

create temporary table import_result on commit drop as
  select public.agent_oauth_import_supabase_clients(array['af200000-0000-4000-8000-000000000002']) as answer;

select is(
  (select answer ->> 'source' from import_result),
  case when to_regclass('auth.oauth_clients') is null then 'absent' else 'supabase' end,
  'the import reads Supabase''s clients where there are any, and says so where there is no such table'
);
select case when (select present from import_fixture) then
  is(
    (select row(client_name, client_uri, redirect_uris, token_endpoint_auth_method, client_secret_hash, surface)::text
       from public.agent_oauth_clients where client_id = 'af100000-0000-4000-8000-000000000001'),
    row('Imported public'::text, 'https://claude.com/claude-code'::text, array['http://localhost:8976/callback'], 'none'::text, null::text, 'full'::text)::text,
    'a public client comes across with its id, name, site and redirect URI, and no secret'
  )
  else skip('no auth.oauth_clients on this stack', 1) end;
select case when (select present from import_fixture) then
  is(
    (select row(redirect_uris, token_endpoint_auth_method, client_secret_hash, surface)::text
       from public.agent_oauth_clients where client_id = 'af200000-0000-4000-8000-000000000002'),
    row(array['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'], 'client_secret_post'::text, repeat('s', 43), 'posts'::text)::text,
    'a confidential client keeps both redirect URIs and its secret''s hash, and is posting-only where named'
  )
  else skip('no auth.oauth_clients on this stack', 1) end;
select case when (select present from import_fixture) then
  ok(
    not exists (select 1 from public.agent_oauth_clients where client_id = 'af300000-0000-4000-8000-000000000003')
    and (select answer -> 'skipped' @> '[{"client_id": "af300000-0000-4000-8000-000000000003", "reason": "secret_hash_unusable"}]'::jsonb from import_result),
    'a client whose secret is stored in another form is skipped and named'
  )
  else skip('no auth.oauth_clients on this stack', 1) end;

-- ---------------------------------------------------------------------------------------------
-- Housekeeping, and the account's end

update public.agent_oauth_authorizations set expires_at = now() - interval '2 days' where id = 'mbar_' || repeat('d', 43);
select ok(public.agent_oauth_purge_expired() >= 1, 'a request nobody answered is purged a day after it expired');
select is((select count(*)::int from public.agent_oauth_authorizations where id = 'mbar_' || repeat('d', 43)), 0, 'and is gone');

delete from auth.users where id = 'ad100000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.agent_oauth_grants where user_id = 'ad100000-0000-4000-8000-000000000001')
  + (select count(*)::int from public.agent_oauth_authorizations where user_id = 'ad100000-0000-4000-8000-000000000001'),
  0,
  'deleting the account removes its grants and its requests'
);

select * from finish();
rollback;
