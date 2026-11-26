-- Hardening of the app's own authorization server (20261126121704), from its security review
-- (docs/plans/agent-token-broker-plan-2026-11-26.md, "After the security review"):
--
-- 1. Bounds. A grant may be refreshed twelve times an hour, an account may hold twenty live grants
--    per client, and revoked grants are purged, so no account can grow the token table without end.
-- 2. A grant ends with the password it was given under: one changed or reset since ends the
--    grant at its next use, whatever the client did or did not ask.
-- 3. A redirect URI is https, or http on a loopback host, with no fragment and no userinfo,
--    held by the table itself, so no path (the import included) can store another.

-- ---------------------------------------------------------------------------------------------
-- Redirect URIs

create function public.agent_oauth_redirect_uri_ok(p_uri text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_uri is not null
     and char_length(p_uri) between 1 and 2048
     -- No whitespace or control character, no fragment, no userinfo.
     and p_uri !~ '[[:space:][:cntrl:]#@]'
     and (
       p_uri ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'
       or p_uri ~ '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/[^[:space:]]*)?$'
     );
$$;

create function public.agent_oauth_redirect_uris_ok(p_uris text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_uris is not null
     and cardinality(p_uris) between 1 and 10
     and not exists (
       select 1 from unnest(p_uris) as uri where not public.agent_oauth_redirect_uri_ok(uri)
     );
$$;

revoke all on function public.agent_oauth_redirect_uri_ok(text) from public, anon, authenticated;
revoke all on function public.agent_oauth_redirect_uris_ok(text[]) from public, anon, authenticated;
grant execute on function public.agent_oauth_redirect_uri_ok(text) to service_role;
grant execute on function public.agent_oauth_redirect_uris_ok(text[]) to service_role;

alter table public.agent_oauth_clients
  add constraint agent_oauth_clients_redirect_uris_are_web
  check (public.agent_oauth_redirect_uris_ok(redirect_uris));

alter table public.agent_oauth_authorizations
  add constraint agent_oauth_authorizations_redirect_uri_is_web
  check (public.agent_oauth_redirect_uri_ok(redirect_uri));

-- ---------------------------------------------------------------------------------------------
-- A grant remembers the password it was given under

-- A fingerprint of the account's stored password hash: it changes when the password is changed or
-- reset, and for an account with no password (Google, Apple) it never does. A hash of a hash, kept
-- in a service-role-only table; the stored password hash itself is never copied.
create function public.agent_oauth_credential_fingerprint(p_encrypted_password text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(p_encrypted_password, ''), 'UTF8')), 'hex');
$$;

revoke all on function public.agent_oauth_credential_fingerprint(text) from public, anon, authenticated;
grant execute on function public.agent_oauth_credential_fingerprint(text) to service_role;

alter table public.agent_oauth_grants add column credential_fingerprint text;

update public.agent_oauth_grants as grant_row
   set credential_fingerprint = public.agent_oauth_credential_fingerprint(account.encrypted_password)
  from auth.users as account
 where account.id = grant_row.user_id;

alter table public.agent_oauth_grants alter column credential_fingerprint set not null;

alter table public.agent_oauth_grants drop constraint agent_oauth_grants_revoked_reason_check;
alter table public.agent_oauth_grants
  add constraint agent_oauth_grants_revoked_reason_check
  check (revoked_reason in ('user', 'client', 'reuse', 'code_replay', 'operator', 'credentials_changed', 'superseded'));

-- ---------------------------------------------------------------------------------------------
-- Issue: with the fingerprint, and at most twenty live grants per account and client

create or replace function public.agent_oauth_issue_grant(
  p_authorization_id text,
  p_access_hash text,
  p_refresh_hash text,
  p_access_ttl_seconds integer,
  p_refresh_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.agent_oauth_authorizations%rowtype;
  v_grant_id uuid;
  v_fingerprint text;
  v_old record;
begin
  if p_access_ttl_seconds < 1 or p_refresh_ttl_seconds < 1 then
    raise exception 'token lifetimes must be positive';
  end if;
  select * into v_authorization
    from public.agent_oauth_authorizations
   where id = p_authorization_id
     for update;
  if not found
     or v_authorization.status <> 'consumed'
     or v_authorization.grant_id is not null
     or v_authorization.user_id is null
     or v_authorization.consumed_at is null
     or v_authorization.consumed_at < now() - interval '1 minute' then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if exists (
    select 1 from public.agent_oauth_clients
     where client_id = v_authorization.client_id and disabled_at is not null
  ) then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select public.agent_oauth_credential_fingerprint(account.encrypted_password) into v_fingerprint
    from auth.users as account
   where account.id = v_authorization.user_id and account.deleted_at is null;
  if v_fingerprint is null then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  insert into public.agent_oauth_grants (user_id, client_id, surface, credential_fingerprint)
  values (v_authorization.user_id, v_authorization.client_id, v_authorization.surface, v_fingerprint)
  returning id into v_grant_id;
  update public.agent_oauth_authorizations set grant_id = v_grant_id where id = v_authorization.id;
  insert into public.agent_oauth_tokens (token_hash, kind, grant_id, expires_at) values
    (p_access_hash, 'access', v_grant_id, now() + make_interval(secs => p_access_ttl_seconds)),
    (p_refresh_hash, 'refresh', v_grant_id, now() + make_interval(secs => p_refresh_ttl_seconds));
  -- Twenty live grants per account and client (one per computer that connected it): the oldest
  -- beyond that end, so approving over and over cannot pile grants up.
  for v_old in
    select id from public.agent_oauth_grants
     where user_id = v_authorization.user_id
       and client_id = v_authorization.client_id
       and revoked_at is null
     order by created_at desc, id desc
     offset 20
  loop
    perform public.agent_oauth_revoke_grant(v_old.id, 'superseded');
  end loop;
  return jsonb_build_object(
    'outcome', 'issued',
    'grant_id', v_grant_id,
    'user_id', v_authorization.user_id,
    'client_id', v_authorization.client_id,
    'surface', v_authorization.surface
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Refresh: a rate per grant, and the password check

create or replace function public.agent_oauth_rotate_refresh_token(
  p_refresh_hash text,
  p_client_id text,
  p_access_hash text,
  p_new_refresh_hash text,
  p_access_ttl_seconds integer,
  p_refresh_ttl_seconds integer,
  p_reuse_grace_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token public.agent_oauth_tokens%rowtype;
  v_grant public.agent_oauth_grants%rowtype;
  v_grant_id uuid;
  v_fingerprint text;
begin
  if p_access_ttl_seconds < 1 or p_refresh_ttl_seconds < 1 or p_reuse_grace_seconds < 0 then
    raise exception 'token lifetimes must be positive';
  end if;
  -- Which grant, without a lock: the grant is locked first and its token second, the order the
  -- revoke functions take them in.
  select grant_id into v_grant_id
    from public.agent_oauth_tokens
   where token_hash = p_refresh_hash and kind = 'refresh';
  if v_grant_id is null then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select * into v_grant
    from public.agent_oauth_grants
   where id = v_grant_id
     for update;
  -- Another client's token changes nothing: it is not this caller's to burn.
  if not found or v_grant.client_id <> p_client_id or v_grant.revoked_at is not null then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select * into v_token
    from public.agent_oauth_tokens
   where token_hash = p_refresh_hash and kind = 'refresh'
     for update;
  if not found then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if exists (
    select 1 from public.agent_oauth_clients
     where client_id = v_grant.client_id and disabled_at is not null
  ) then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if v_token.expires_at <= now() then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  -- The password the grant was given under has been changed or reset, or the account is gone.
  select public.agent_oauth_credential_fingerprint(account.encrypted_password) into v_fingerprint
    from auth.users as account
   where account.id = v_grant.user_id and account.deleted_at is null;
  if v_fingerprint is distinct from v_grant.credential_fingerprint then
    perform public.agent_oauth_revoke_grant(v_grant.id, 'credentials_changed');
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if v_token.used_at is not null
     and v_token.used_at < now() - make_interval(secs => p_reuse_grace_seconds) then
    perform public.agent_oauth_revoke_grant(v_grant.id, 'reuse');
    return jsonb_build_object('outcome', 'reuse_detected', 'grant_id', v_grant.id, 'user_id', v_grant.user_id);
  end if;
  -- Twelve refreshes of one grant an hour. An access token lasts the hour, so an honest client
  -- needs one, and a few processes sharing a stored token a few more; a loop is told to wait and
  -- changes nothing. It also bounds how many pairs the reuse grace can hand out, and with the
  -- ninety days a used token is kept, how many rows a grant can hold.
  if (select count(*) from public.agent_oauth_tokens
       where grant_id = v_grant.id and kind = 'refresh' and created_at > now() - interval '1 hour') >= 12 then
    return jsonb_build_object('outcome', 'rate_limited', 'grant_id', v_grant.id, 'user_id', v_grant.user_id);
  end if;
  update public.agent_oauth_tokens
     set used_at = coalesce(used_at, now())
   where token_hash = p_refresh_hash;
  delete from public.agent_oauth_tokens where grant_id = v_grant.id and expires_at <= now();
  insert into public.agent_oauth_tokens (token_hash, kind, grant_id, expires_at) values
    (p_access_hash, 'access', v_grant.id, now() + make_interval(secs => p_access_ttl_seconds)),
    (p_new_refresh_hash, 'refresh', v_grant.id, now() + make_interval(secs => p_refresh_ttl_seconds));
  return jsonb_build_object(
    'outcome', 'rotated',
    'grant_id', v_grant.id,
    'user_id', v_grant.user_id,
    'client_id', v_grant.client_id,
    'surface', v_grant.surface
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Admission: the password check

create or replace function public.agent_oauth_token_admission(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  select token.grant_id,
         grant_row.user_id,
         grant_row.client_id,
         grant_row.surface,
         grant_row.last_used_at,
         grant_row.credential_fingerprint,
         public.agent_oauth_credential_fingerprint(account.encrypted_password) as current_fingerprint,
         account.created_at as account_created_at,
         account.email,
         coalesce(account.is_anonymous, false) as is_anonymous,
         coalesce(account.banned_until > now(), false) as banned,
         profile.identity_state
    into v_row
    from public.agent_oauth_tokens as token
    join public.agent_oauth_grants as grant_row on grant_row.id = token.grant_id
    join public.agent_oauth_clients as client on client.client_id = grant_row.client_id
    join auth.users as account on account.id = grant_row.user_id and account.deleted_at is null
    left join public.profiles as profile on profile.id = account.id
   where token.token_hash = p_token_hash
     and token.kind = 'access'
     and token.expires_at > now()
     and grant_row.revoked_at is null
     and client.disabled_at is null;
  if not found then
    return null;
  end if;
  -- The password the grant was given under has been changed or reset since: the grant ends here,
  -- with every token under it.
  if v_row.current_fingerprint is distinct from v_row.credential_fingerprint then
    perform public.agent_oauth_revoke_grant(v_row.grant_id, 'credentials_changed');
    return null;
  end if;
  if v_row.last_used_at is null or v_row.last_used_at < now() - interval '5 minutes' then
    update public.agent_oauth_grants set last_used_at = now() where id = v_row.grant_id;
  end if;
  return jsonb_build_object(
    'grant_id', v_row.grant_id,
    'user_id', v_row.user_id,
    'client_id', v_row.client_id,
    'surface', v_row.surface,
    'state', v_row.identity_state,
    'created_at', v_row.account_created_at,
    'email', v_row.email,
    'is_anonymous', v_row.is_anonymous,
    'banned', v_row.banned
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Housekeeping: revoked grants go too, a month after they ended

create or replace function public.agent_oauth_purge_expired()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorizations integer;
  v_tokens integer;
  v_grants integer;
begin
  with doomed as (
    select id from public.agent_oauth_authorizations
     where expires_at < now() - interval '1 day'
     order by expires_at
     limit 500
  )
  delete from public.agent_oauth_authorizations as request
   using doomed where request.id = doomed.id;
  get diagnostics v_authorizations = row_count;
  with doomed as (
    select token_hash from public.agent_oauth_tokens
     where expires_at < now() - interval '1 day'
     order by expires_at
     limit 500
  )
  delete from public.agent_oauth_tokens as token
   using doomed where token.token_hash = doomed.token_hash;
  get diagnostics v_tokens = row_count;
  with doomed as (
    select id from public.agent_oauth_grants
     where revoked_at < now() - interval '30 days'
     order by revoked_at
     limit 500
  )
  delete from public.agent_oauth_grants as grant_row
   using doomed where grant_row.id = doomed.id;
  get diagnostics v_grants = row_count;
  return v_authorizations + v_tokens + v_grants;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The import skips a client whose redirect URIs the table would refuse, and names it

create or replace function public.agent_oauth_import_supabase_clients(p_posting_only_client_ids text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client record;
  v_method text;
  v_hash text;
  v_uris text[];
  v_imported jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  if to_regclass('auth.oauth_clients') is null then
    return jsonb_build_object('imported', v_imported, 'skipped', v_skipped, 'source', 'absent');
  end if;
  for v_client in execute
    'select id::text as client_id, client_name, client_uri, redirect_uris, '
    || 'token_endpoint_auth_method, client_secret_hash '
    || 'from auth.oauth_clients where deleted_at is null order by created_at'
  loop
    if exists (select 1 from public.agent_oauth_clients where client_id = v_client.client_id) then
      v_skipped := v_skipped || jsonb_build_object('client_id', v_client.client_id, 'reason', 'already_present');
      continue;
    end if;
    v_method := coalesce(v_client.token_endpoint_auth_method, 'none');
    v_hash := nullif(v_client.client_secret_hash, '');
    if v_method = 'none' then
      v_hash := null;
    elsif v_hash is null or v_hash !~ '^[A-Za-z0-9_-]{43}$' then
      v_skipped := v_skipped || jsonb_build_object('client_id', v_client.client_id, 'reason', 'secret_hash_unusable');
      continue;
    end if;
    select coalesce(array_agg(trimmed), '{}') into v_uris
      from (
        select btrim(uri) as trimmed
          from unnest(string_to_array(coalesce(v_client.redirect_uris, ''), ',')) as uri
      ) as uris
     where trimmed <> '';
    if not public.agent_oauth_redirect_uris_ok(v_uris) then
      v_skipped := v_skipped || jsonb_build_object('client_id', v_client.client_id, 'reason', 'redirect_uris_unusable');
      continue;
    end if;
    insert into public.agent_oauth_clients (
      client_id, client_name, client_uri, redirect_uris, token_endpoint_auth_method, client_secret_hash, surface
    ) values (
      v_client.client_id,
      left(coalesce(nullif(btrim(v_client.client_name), ''), v_client.client_id), 200),
      nullif(btrim(v_client.client_uri), ''),
      v_uris,
      v_method,
      v_hash,
      case when v_client.client_id = any (p_posting_only_client_ids) then 'posts' else 'full' end
    );
    v_imported := v_imported || jsonb_build_object(
      'client_id', v_client.client_id,
      'client_name', v_client.client_name,
      'token_endpoint_auth_method', v_method,
      'surface', case when v_client.client_id = any (p_posting_only_client_ids) then 'posts' else 'full' end
    );
  end loop;
  return jsonb_build_object('imported', v_imported, 'skipped', v_skipped, 'source', 'supabase');
end;
$$;
