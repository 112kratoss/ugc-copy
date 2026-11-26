-- The app's authorization server after its security review (migration 20261126151150): a redirect
-- URI is a web address the table itself holds to; a grant ends with the password it was given
-- under; a grant is refreshed twelve times an hour and no more; an account holds twenty live
-- grants per client; revoked grants are purged.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(51);

-- ---------------------------------------------------------------------------------------------
-- Redirect URIs

select ok(public.agent_oauth_redirect_uri_ok('https://claude.ai/api/mcp/auth_callback'), 'an https address is a redirect URI');
select ok(public.agent_oauth_redirect_uri_ok('https://chatgpt.com/connector/oauth/abc_DEF-123?x=1'), 'with a path and a query');
select ok(public.agent_oauth_redirect_uri_ok('http://localhost:8976/callback'), 'http on localhost is one');
select ok(public.agent_oauth_redirect_uri_ok('http://127.0.0.1:8977/callback/PPpoTd8EYBlz'), 'and on 127.0.0.1');
select ok(public.agent_oauth_redirect_uri_ok('http://[::1]:8787/callback'), 'and on the IPv6 loopback');
select ok(public.agent_oauth_redirect_uri_ok('https://ok.test/@handle/callback'), 'an @ in the path is not userinfo');
select ok(public.agent_oauth_redirect_uri_ok('https://ok.test:8443'), 'a bare origin with a port is one');
select ok(not public.agent_oauth_redirect_uri_ok('HTTPS://claude.ai/cb'), 'the scheme is lower case');
select ok(not public.agent_oauth_redirect_uri_ok('https://claude.ai?x=1'), 'a query needs a path');
select ok(not public.agent_oauth_redirect_uri_ok('javascript:alert(1)'), 'a javascript: address is not');
select ok(not public.agent_oauth_redirect_uri_ok('data:text/html,<script>'), 'nor a data: address');
select ok(not public.agent_oauth_redirect_uri_ok('myapp://callback'), 'nor a custom scheme');
select ok(not public.agent_oauth_redirect_uri_ok('http://example.com/callback'), 'nor http off the loopback');
select ok(not public.agent_oauth_redirect_uri_ok('http://localhost.evil.test/callback'), 'nor a host that only starts like one');
select ok(not public.agent_oauth_redirect_uri_ok('https://claude.ai/cb#fragment'), 'nor one with a fragment');
select ok(not public.agent_oauth_redirect_uri_ok('https://user:pass@claude.ai/cb'), 'nor one with userinfo');
select ok(not public.agent_oauth_redirect_uri_ok('https://user@claude.ai/cb'), 'with or without a password');
select ok(not public.agent_oauth_redirect_uri_ok('https://claude.ai/cb https://evil.test/'), 'nor two in one');
select ok(not public.agent_oauth_redirect_uri_ok(''), 'nor nothing');
select ok(not public.agent_oauth_redirect_uri_ok(null), 'nor null');

select throws_ok(
  $$insert into public.agent_oauth_clients (client_id, client_name, redirect_uris)
    values ('client-script', 'Script', array['javascript:alert(1)'])$$,
  '23514', null, 'the clients table refuses a redirect URI that is not a web address'
);
select throws_ok(
  $$insert into public.agent_oauth_clients (client_id, client_name, redirect_uris)
    values ('client-mixed', 'Mixed', array['https://ok.test/cb', 'http://example.com/cb'])$$,
  '23514', null, 'even one among good ones'
);

-- ---------------------------------------------------------------------------------------------
-- Fixtures: one account with a password, one client, and a way to make a grant as the token
-- endpoint does (a consumed code, then the issue).

insert into auth.users (id, email, aud, role, is_anonymous, encrypted_password, created_at, updated_at, raw_app_meta_data, raw_user_meta_data) values
  ('ba100000-0000-4000-8000-000000000001'::uuid, 'hardening-owner@example.invalid', 'authenticated', 'authenticated', false, 'stored-hash-one',
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb),
  ('ba200000-0000-4000-8000-000000000002'::uuid, 'hardening-other@example.invalid', 'authenticated', 'authenticated', false, null,
   timezone('utc'::text, now()), timezone('utc'::text, now()), '{}'::jsonb, '{}'::jsonb);

insert into public.agent_oauth_clients (client_id, client_name, redirect_uris) values
  ('client-hard', 'Hardening client', array['http://localhost:8976/callback']);

select throws_ok(
  $$insert into public.agent_oauth_authorizations (id, client_id, redirect_uri, surface, code_challenge, expires_at)
    values ('mbar_' || repeat('j', 43), 'client-hard', 'javascript:alert(1)', 'full', repeat('c', 43), now())$$,
  '23514', null, 'a request cannot be stored with a redirect URI that is not a web address either'
);

create function pg_temp.grant_for(p_user uuid, p_tag text) returns uuid language plpgsql as $$
declare
  v_id text := 'mbar_' || rpad(p_tag, 43, 'z');
  v_answer jsonb;
begin
  insert into public.agent_oauth_authorizations
    (id, client_id, redirect_uri, surface, code_challenge, user_id, status, code_hash, code_expires_at, expires_at)
  values (v_id, 'client-hard', 'http://localhost:8976/callback', 'full', repeat('c', 43), p_user, 'approved',
          rpad(p_tag || 'code', 43, 'k'), now() + interval '2 minutes', now() + interval '10 minutes');
  perform public.agent_oauth_consume_code(rpad(p_tag || 'code', 43, 'k'));
  v_answer := public.agent_oauth_issue_grant(v_id, rpad(p_tag || 'acc', 43, 'A'), rpad(p_tag || 'ref', 43, 'R'), 3600, 7776000);
  return (v_answer ->> 'grant_id')::uuid;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- A grant ends with the password it was given under

create temporary table made on commit drop as
  select pg_temp.grant_for('ba100000-0000-4000-8000-000000000001', 'one') as first_grant;

select is(
  (select credential_fingerprint from public.agent_oauth_grants where id = (select first_grant from made)),
  public.agent_oauth_credential_fingerprint('stored-hash-one'),
  'a grant is issued with the fingerprint of the account''s stored password hash'
);
select ok(
  (select credential_fingerprint from public.agent_oauth_grants where id = (select first_grant from made)) ~ '^[0-9a-f]{64}$',
  'which is a SHA-256 digest, 64 hex characters, and so not the stored hash'
);
select ok(public.agent_oauth_token_admission(rpad('oneacc', 43, 'A')) is not null, 'its access token admits');

update auth.users set encrypted_password = 'stored-hash-two' where id = 'ba100000-0000-4000-8000-000000000001';
select is(public.agent_oauth_token_admission(rpad('oneacc', 43, 'A')), null, 'after the password changes, the token admits nobody');
select is(
  (select revoked_reason from public.agent_oauth_grants where id = (select first_grant from made)),
  'credentials_changed',
  'the grant is ended, and says why'
);
select is(
  (select count(*)::int from public.agent_oauth_tokens where grant_id = (select first_grant from made)),
  0,
  'with its refresh token, so nothing renews it'
);

-- The same at a refresh, for a grant nobody has used since the change.
insert into made select pg_temp.grant_for('ba100000-0000-4000-8000-000000000001', 'two');
update auth.users set encrypted_password = 'stored-hash-three' where id = 'ba100000-0000-4000-8000-000000000001';
select is(
  public.agent_oauth_rotate_refresh_token(rpad('tworef', 43, 'R'), 'client-hard', repeat('n', 43), repeat('m', 43), 3600, 7776000, 10) ->> 'outcome',
  'invalid',
  'a refresh after the password changes renews nothing'
);
select is(
  (select count(*)::int from public.agent_oauth_grants
    where user_id = 'ba100000-0000-4000-8000-000000000001' and revoked_reason = 'credentials_changed'),
  2,
  'and ends that grant too'
);

-- An account with no password (Google, Apple) is never caught by it.
insert into made select pg_temp.grant_for('ba200000-0000-4000-8000-000000000002', 'tri');
update auth.users set updated_at = now() + interval '1 second', raw_user_meta_data = '{"name":"x"}'::jsonb
 where id = 'ba200000-0000-4000-8000-000000000002';
select ok(public.agent_oauth_token_admission(rpad('triacc', 43, 'A')) is not null, 'a change that is not the password ends nothing');

-- ---------------------------------------------------------------------------------------------
-- Twelve refresh tokens an hour per grant

create temporary table refreshes (step integer, outcome text) on commit drop;
do $loop$
declare
  v_previous text := rpad('triref', 43, 'R');
  v_next text;
  v_answer jsonb;
begin
  for step in 1..12 loop
    v_next := rpad('r' || step, 43, 'q');
    v_answer := public.agent_oauth_rotate_refresh_token(v_previous, 'client-hard', rpad('a' || step, 43, 'q'), v_next, 3600, 7776000, 10);
    insert into refreshes values (step, v_answer ->> 'outcome');
    if v_answer ->> 'outcome' = 'rotated' then
      v_previous := v_next;
    end if;
  end loop;
end;
$loop$;

select is((select count(*)::int from refreshes where step <= 11 and outcome = 'rotated'), 11, 'eleven refreshes follow the first token inside the hour');
select is((select outcome from refreshes where step = 12), 'rate_limited', 'the next is told to wait');
select is((select used_at from public.agent_oauth_tokens where token_hash = rpad('r11', 43, 'q')), null, 'and the token it presented is untouched, to be used once the hour has moved on');
select is(
  (select count(*)::int from public.agent_oauth_tokens
    where grant_id = (select grant_id from public.agent_oauth_tokens where token_hash = rpad('r11', 43, 'q')) and kind = 'refresh'),
  12,
  'so a grant holds twelve refresh rows for the hour, however hard it is driven'
);
select ok(public.agent_oauth_token_admission(rpad('a11', 43, 'q')) is not null, 'its newest access token still admits');
select ok(
  (select revoked_at is null from public.agent_oauth_grants
    where id = (select grant_id from public.agent_oauth_tokens where token_hash = rpad('r11', 43, 'q'))),
  'and the grant is not ended for it'
);
update public.agent_oauth_tokens set created_at = now() - interval '61 minutes'
 where kind = 'refresh' and token_hash <> rpad('r11', 43, 'q')
   and grant_id = (select grant_id from public.agent_oauth_tokens where token_hash = rpad('r11', 43, 'q'));
select is(
  public.agent_oauth_rotate_refresh_token(rpad('r11', 43, 'q'), 'client-hard', repeat('v', 43), repeat('w', 43), 3600, 7776000, 10) ->> 'outcome',
  'rotated',
  'once the hour has moved on, it refreshes again'
);

-- ---------------------------------------------------------------------------------------------
-- Twenty live grants per account and client

insert into public.agent_oauth_grants (user_id, client_id, surface, credential_fingerprint, created_at)
select 'ba200000-0000-4000-8000-000000000002', 'client-hard', 'full', public.agent_oauth_credential_fingerprint(null),
       now() - make_interval(mins => n)
  from generate_series(1, 20) as n;
select is(
  (select count(*)::int from public.agent_oauth_grants where user_id = 'ba200000-0000-4000-8000-000000000002' and revoked_at is null),
  21,
  'twenty-one live grants before the next approval'
);
insert into made select pg_temp.grant_for('ba200000-0000-4000-8000-000000000002', 'cap');
select is(
  (select count(*)::int from public.agent_oauth_grants where user_id = 'ba200000-0000-4000-8000-000000000002' and revoked_at is null),
  20,
  'issuing one more leaves twenty live'
);
select is(
  (select count(*)::int from public.agent_oauth_grants
    where user_id = 'ba200000-0000-4000-8000-000000000002' and revoked_reason = 'superseded'
      and created_at <= now() - interval '19 minutes'),
  2,
  'the oldest are the ones ended'
);
select ok(public.agent_oauth_token_admission(rpad('capacc', 43, 'A')) is not null, 'and the newest admits');

-- ---------------------------------------------------------------------------------------------
-- Revoked grants are purged a month after they ended

update public.agent_oauth_grants set revoked_at = now() - interval '31 days'
 where user_id = 'ba200000-0000-4000-8000-000000000002' and revoked_reason = 'superseded';
select ok(public.agent_oauth_purge_expired() >= 2, 'the purge takes grants revoked more than thirty days ago');
select is(
  (select count(*)::int from public.agent_oauth_grants
    where user_id = 'ba200000-0000-4000-8000-000000000002' and revoked_reason = 'superseded'),
  0,
  'and they are gone'
);
select is(
  (select count(*)::int from public.agent_oauth_grants where user_id = 'ba100000-0000-4000-8000-000000000001'),
  2,
  'a grant revoked today stays, to be told from one that never was'
);

-- An account keeps twenty ended grants per client: approving in a loop leaves no more behind.
insert into public.agent_oauth_grants (user_id, client_id, surface, credential_fingerprint, created_at, revoked_at, revoked_reason)
select 'ba200000-0000-4000-8000-000000000002', 'client-hard', 'full', public.agent_oauth_credential_fingerprint(null),
       now() - make_interval(hours => n), now() - make_interval(mins => n), 'user'
  from generate_series(1, 25) as n;
insert into made select pg_temp.grant_for('ba200000-0000-4000-8000-000000000002', 'trm');
select is(
  (select count(*)::int from public.agent_oauth_grants where user_id = 'ba200000-0000-4000-8000-000000000002' and revoked_at is not null),
  20,
  'after the next approval the account has twenty ended grants for the client, the newest'
);
select is(
  (select count(*)::int from public.agent_oauth_grants where user_id = 'ba200000-0000-4000-8000-000000000002' and revoked_at is null),
  20,
  'and twenty live ones'
);
select has_index('public', 'agent_oauth_grants', 'agent_oauth_grants_revoked_idx', 'the purge reads ended grants by an index');

-- ---------------------------------------------------------------------------------------------
-- The import refuses a client whose redirect URI is not a web address (where the stack has
-- Supabase Auth's table in the shape GoTrue v2.186 gives it; a Postgres-only replay has none).

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
        (id, client_secret_hash, registration_type, redirect_uris, grant_types, client_name, client_type, token_endpoint_auth_method)
      values
        ('bf100000-0000-4000-8000-000000000001', null, 'manual', 'javascript:alert(1)', 'authorization_code,refresh_token', 'Imported script', 'public', 'none'),
        ('bf200000-0000-4000-8000-000000000002', null, 'manual', 'https://ok.test/cb,http://example.com/cb', 'authorization_code,refresh_token', 'Imported mixed', 'public', 'none'),
        ('bf300000-0000-4000-8000-000000000003', null, 'manual', 'https://ok.test/cb', 'authorization_code,refresh_token', 'Imported good', 'public', 'none')
    $sql$;
  end if;
end;
$fixture$;
create temporary table import_result on commit drop as
  select public.agent_oauth_import_supabase_clients() as answer;

select case when (select present from import_fixture) then
  ok(
    (select answer -> 'skipped' @> '[{"client_id": "bf100000-0000-4000-8000-000000000001", "reason": "redirect_uris_unusable"},
                                     {"client_id": "bf200000-0000-4000-8000-000000000002", "reason": "redirect_uris_unusable"}]'::jsonb
       from import_result)
    and not exists (select 1 from public.agent_oauth_clients where client_id in ('bf100000-0000-4000-8000-000000000001', 'bf200000-0000-4000-8000-000000000002')),
    'the import skips and names a client with a redirect URI that is not a web address'
  )
  else skip('no auth.oauth_clients on this stack', 1) end;
select case when (select present from import_fixture) then
  ok(exists (select 1 from public.agent_oauth_clients where client_id = 'bf300000-0000-4000-8000-000000000003'), 'and still imports the one beside them')
  else skip('no auth.oauth_clients on this stack', 1) end;

select * from finish();
rollback;
