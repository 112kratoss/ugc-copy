-- The app's own OAuth 2.1 authorization server for the MCP routes
-- (docs/plans/agent-token-broker-plan-2026-11-26.md): the clients agents sign in through, each
-- authorization request and its code, each account's grants, and the opaque access and refresh
-- tokens issued under a grant. An agent's token is a random string whose hash is a row here and
-- nothing anywhere else: it is not a Supabase JWT and opens nothing at the Supabase project.
--
-- All four tables are the service role's alone: row-level security on with no policy, and no
-- grant to anon or authenticated. The app's routes read and write them
-- (src/lib/agent-oauth-store.ts). A secret is never stored: client secrets, codes, consent
-- tokens and tokens are kept as base64url(SHA-256(value)), 43 characters.

-- ---------------------------------------------------------------------------------------------
-- Clients

create table public.agent_oauth_clients (
  -- Public, carried by every authorize URL. The ids Supabase Auth's OAuth server issued are kept.
  client_id text primary key check (client_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  client_name text not null check (char_length(client_name) between 1 and 200),
  client_uri text check (client_uri is null or char_length(client_uri) <= 2048),
  -- Matched as exact strings: no wildcard, no port-agnostic loopback.
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method in ('none', 'client_secret_post', 'client_secret_basic')),
  client_secret_hash text check (client_secret_hash is null or client_secret_hash ~ '^[A-Za-z0-9_-]{43}$'),
  -- The widest MCP server a grant to this client may reach: `posts` clients never get `full`.
  surface text not null default 'full' check (surface in ('full', 'posts')),
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  -- A public client has no secret; a confidential one always has one.
  constraint agent_oauth_clients_secret_matches_method
    check ((token_endpoint_auth_method = 'none') = (client_secret_hash is null))
);

comment on table public.agent_oauth_clients is
  'OAuth clients of the app''s own authorization server for MCP; pre-registered by an operator, service role only.';

-- ---------------------------------------------------------------------------------------------
-- Grants: one per approval on the consent page

create table public.agent_oauth_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null references public.agent_oauth_clients(client_id) on delete cascade,
  surface text not null check (surface in ('full', 'posts')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in ('user', 'client', 'reuse', 'code_replay', 'operator')),
  constraint agent_oauth_grants_revocation_has_reason
    check ((revoked_at is null) = (revoked_reason is null))
);

comment on table public.agent_oauth_grants is
  'One row per consent an account gave an OAuth client for an MCP server; revoking it ends every token under it.';

-- Connected apps: an account's live grants.
create index agent_oauth_grants_user_live_idx
  on public.agent_oauth_grants (user_id, created_at desc) where revoked_at is null;
create index agent_oauth_grants_client_idx
  on public.agent_oauth_grants (client_id);

-- ---------------------------------------------------------------------------------------------
-- Authorization requests and their codes

create table public.agent_oauth_authorizations (
  -- The `authorization_id` the consent page carries: a handle, not a credential. Answering it
  -- needs the bound account's session and the consent token.
  id text primary key check (id ~ '^mbar_[A-Za-z0-9_-]{43}$'),
  client_id text not null references public.agent_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 2048),
  surface text not null check (surface in ('full', 'posts')),
  scope text check (scope is null or char_length(scope) <= 512),
  state text check (state is null or char_length(state) <= 2048),
  -- PKCE, S256 only: base64url(SHA-256(code_verifier)).
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  -- The account the consent page was rendered for; null until then, and never rebound.
  user_id uuid references auth.users(id) on delete cascade,
  consent_token_hash text check (consent_token_hash is null or consent_token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'consumed')),
  code_hash text unique check (code_hash is null or code_hash ~ '^[A-Za-z0-9_-]{43}$'),
  code_expires_at timestamptz,
  grant_id uuid references public.agent_oauth_grants(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  consumed_at timestamptz,
  constraint agent_oauth_authorizations_code_has_expiry
    check ((code_hash is null) = (code_expires_at is null)),
  constraint agent_oauth_authorizations_decision_needs_account
    check (status = 'pending' or user_id is not null)
);

comment on table public.agent_oauth_authorizations is
  'One row per /oauth/authorize request: what was asked, who was shown it, the answer, and the hash of the code an approval issued.';

create index agent_oauth_authorizations_expires_idx
  on public.agent_oauth_authorizations (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Tokens

create table public.agent_oauth_tokens (
  token_hash text primary key check (token_hash ~ '^[A-Za-z0-9_-]{43}$'),
  kind text not null check (kind in ('access', 'refresh')),
  grant_id uuid not null references public.agent_oauth_grants(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- A refresh token's first use. It is kept until it expires so a later use can be told apart
  -- from an unknown token: reuse past the grace revokes the grant.
  used_at timestamptz,
  constraint agent_oauth_tokens_only_refresh_is_used check (used_at is null or kind = 'refresh')
);

comment on table public.agent_oauth_tokens is
  'Hashes of the opaque access and refresh tokens issued under a grant; the tokens themselves are stored nowhere.';

create index agent_oauth_tokens_grant_idx on public.agent_oauth_tokens (grant_id);
create index agent_oauth_tokens_expires_idx on public.agent_oauth_tokens (expires_at);

-- ---------------------------------------------------------------------------------------------
-- Privileges: the service role alone, on all four

alter table public.agent_oauth_clients enable row level security;
alter table public.agent_oauth_grants enable row level security;
alter table public.agent_oauth_authorizations enable row level security;
alter table public.agent_oauth_tokens enable row level security;

revoke all on public.agent_oauth_clients from public, anon, authenticated, service_role;
revoke all on public.agent_oauth_grants from public, anon, authenticated, service_role;
revoke all on public.agent_oauth_authorizations from public, anon, authenticated, service_role;
revoke all on public.agent_oauth_tokens from public, anon, authenticated, service_role;

grant select, insert, update on public.agent_oauth_clients to service_role;
grant select on public.agent_oauth_grants to service_role;
grant select, insert, update on public.agent_oauth_authorizations to service_role;
-- Tokens and grants change only through the functions below, which run as their owner.

-- ---------------------------------------------------------------------------------------------
-- Functions. All are SECURITY DEFINER with an empty search_path and executable by the service
-- role alone, so each state change is one transaction and no Data API role can reach them.

-- Ends a grant: marks it revoked and deletes every token under it, so access and refresh stop at
-- once. False when it was already revoked or does not exist.
create function public.agent_oauth_revoke_grant(p_grant_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revoked boolean;
begin
  if p_grant_id is null then
    return false;
  end if;
  update public.agent_oauth_grants
     set revoked_at = now(), revoked_reason = p_reason
   where id = p_grant_id and revoked_at is null;
  v_revoked := found;
  delete from public.agent_oauth_tokens where grant_id = p_grant_id;
  return v_revoked;
end;
$$;

-- Connected apps' Disconnect: every live grant an account gave a client. With no client named,
-- every live grant of the account: "Sign out everywhere" ends what acts as the account too.
-- A request the account has been shown or has approved, whose code is not yet exchanged, ends
-- with them: an Allow followed at once by Disconnect must not still produce a grant.
create function public.agent_oauth_revoke_grants(p_user_id uuid, p_client_id text, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant record;
  v_count integer := 0;
begin
  for v_grant in
    select id from public.agent_oauth_grants
     where user_id = p_user_id
       and (p_client_id is null or client_id = p_client_id)
       and revoked_at is null
     for update
  loop
    if public.agent_oauth_revoke_grant(v_grant.id, p_reason) then
      v_count := v_count + 1;
    end if;
  end loop;
  update public.agent_oauth_authorizations
     set status = 'denied', decided_at = now(), consent_token_hash = null
   where user_id = p_user_id
     and (p_client_id is null or client_id = p_client_id)
     and status in ('pending', 'approved');
  return v_count;
end;
$$;

-- RFC 7009: a client ends the grant one of its own tokens belongs to. False for a token that is
-- unknown or another client's, which the endpoint answers the same way.
create function public.agent_oauth_revoke_token(p_token_hash text, p_client_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant_id uuid;
begin
  select token.grant_id into v_grant_id
    from public.agent_oauth_tokens as token
    join public.agent_oauth_grants as grant_row on grant_row.id = token.grant_id
   where token.token_hash = p_token_hash and grant_row.client_id = p_client_id;
  if v_grant_id is null then
    return false;
  end if;
  return public.agent_oauth_revoke_grant(v_grant_id, 'client');
end;
$$;

-- An authorization code is used once. The first presentation marks it consumed and returns what
-- the token endpoint must check (client, redirect URI, PKCE challenge) before it issues anything.
-- A second presentation of a consumed code revokes the grant the first one produced.
create function public.agent_oauth_consume_code(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorization public.agent_oauth_authorizations%rowtype;
begin
  select * into v_authorization
    from public.agent_oauth_authorizations
   where code_hash = p_code_hash
     for update;
  if not found then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if v_authorization.status = 'consumed' then
    perform public.agent_oauth_revoke_grant(v_authorization.grant_id, 'code_replay');
    -- A replay that arrives between the first presentation and its grant finds no grant to
    -- revoke: the request is closed instead, so agent_oauth_issue_grant issues none.
    if v_authorization.grant_id is null then
      update public.agent_oauth_authorizations set status = 'denied' where id = v_authorization.id;
    end if;
    return jsonb_build_object('outcome', 'replayed');
  end if;
  if v_authorization.status <> 'approved'
     or v_authorization.code_expires_at is null
     or v_authorization.code_expires_at <= now()
     or v_authorization.user_id is null then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  update public.agent_oauth_authorizations
     set status = 'consumed', consumed_at = now()
   where id = v_authorization.id;
  return jsonb_build_object(
    'outcome', 'consumed',
    'authorization_id', v_authorization.id,
    'client_id', v_authorization.client_id,
    'redirect_uri', v_authorization.redirect_uri,
    'code_challenge', v_authorization.code_challenge,
    'surface', v_authorization.surface,
    'user_id', v_authorization.user_id
  );
end;
$$;

-- The grant and its first token pair, for a code consumed a moment ago and checked by the token
-- endpoint. One grant per authorization: a second call finds `grant_id` set and issues nothing.
create function public.agent_oauth_issue_grant(
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
  insert into public.agent_oauth_grants (user_id, client_id, surface)
  values (v_authorization.user_id, v_authorization.client_id, v_authorization.surface)
  returning id into v_grant_id;
  update public.agent_oauth_authorizations set grant_id = v_grant_id where id = v_authorization.id;
  insert into public.agent_oauth_tokens (token_hash, kind, grant_id, expires_at) values
    (p_access_hash, 'access', v_grant_id, now() + make_interval(secs => p_access_ttl_seconds)),
    (p_refresh_hash, 'refresh', v_grant_id, now() + make_interval(secs => p_refresh_ttl_seconds));
  return jsonb_build_object(
    'outcome', 'issued',
    'grant_id', v_grant_id,
    'user_id', v_authorization.user_id,
    'client_id', v_authorization.client_id,
    'surface', v_authorization.surface
  );
end;
$$;

-- Refresh token rotation. Each use of a refresh token issues a new pair and marks the old token
-- used. A used token presented again within the grace gets another pair (two processes sharing
-- one stored token race honestly); presented after it, the token was copied, and the grant ends.
create function public.agent_oauth_rotate_refresh_token(
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
begin
  if p_access_ttl_seconds < 1 or p_refresh_ttl_seconds < 1 or p_reuse_grace_seconds < 0 then
    raise exception 'token lifetimes must be positive';
  end if;
  -- Which grant, without a lock: the grant is locked first and its token second, the order the
  -- revoke functions take them in, so a refresh and a Disconnect at the same moment wait for
  -- each other instead of deadlocking.
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
  -- Read again under the grant's lock: a revocation that got there first has deleted it.
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
  if v_token.used_at is not null
     and v_token.used_at < now() - make_interval(secs => p_reuse_grace_seconds) then
    perform public.agent_oauth_revoke_grant(v_grant.id, 'reuse');
    return jsonb_build_object('outcome', 'reuse_detected', 'grant_id', v_grant.id, 'user_id', v_grant.user_id);
  end if;
  update public.agent_oauth_tokens
     set used_at = coalesce(used_at, now())
   where token_hash = p_refresh_hash;
  -- Housekeeping for this grant: what has expired. A used refresh token stays until it expires.
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

-- The MCP routes' admission, in one round trip: the access token's grant and client, and what
-- current_identity_admission() answers for a JWT's subject (the account exists, its lifecycle
-- state, whether it is banned, created_at), plus whether it is a guest. NULL when the token is
-- unknown or expired, its grant revoked, its client disabled, or the account gone.
create function public.agent_oauth_token_admission(p_token_hash text)
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
  -- When the grant was last used, to the nearest five minutes: one write per grant per window.
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

-- Requests nobody answered and tokens long expired, a bounded batch per call.
create function public.agent_oauth_purge_expired()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_authorizations integer;
  v_tokens integer;
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
  return v_authorizations + v_tokens;
end;
$$;

-- Cutover, once: the clients registered with Supabase Auth's OAuth server become this server's
-- clients, with their ids, redirect URIs and, for a confidential client, the hash of its secret
-- (GoTrue stores base64url(SHA-256(secret)), the form kept here), so no id or secret changes
-- hands. A client already present is left alone. A confidential client whose stored hash is in
-- another form is skipped and named, to be given a new secret by the operator.
create function public.agent_oauth_import_supabase_clients(p_posting_only_client_ids text[] default '{}')
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
    if cardinality(v_uris) = 0 or cardinality(v_uris) > 10 then
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

revoke all on function public.agent_oauth_revoke_grant(uuid, text) from public, anon, authenticated;
revoke all on function public.agent_oauth_revoke_grants(uuid, text, text) from public, anon, authenticated;
revoke all on function public.agent_oauth_revoke_token(text, text) from public, anon, authenticated;
revoke all on function public.agent_oauth_consume_code(text) from public, anon, authenticated;
revoke all on function public.agent_oauth_issue_grant(text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_oauth_rotate_refresh_token(text, text, text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.agent_oauth_token_admission(text) from public, anon, authenticated;
revoke all on function public.agent_oauth_purge_expired() from public, anon, authenticated;
revoke all on function public.agent_oauth_import_supabase_clients(text[]) from public, anon, authenticated;

grant execute on function public.agent_oauth_revoke_grant(uuid, text) to service_role;
grant execute on function public.agent_oauth_revoke_grants(uuid, text, text) to service_role;
grant execute on function public.agent_oauth_revoke_token(text, text) to service_role;
grant execute on function public.agent_oauth_consume_code(text) to service_role;
grant execute on function public.agent_oauth_issue_grant(text, text, text, integer, integer) to service_role;
grant execute on function public.agent_oauth_rotate_refresh_token(text, text, text, text, integer, integer, integer) to service_role;
grant execute on function public.agent_oauth_token_admission(text) to service_role;
grant execute on function public.agent_oauth_purge_expired() to service_role;
grant execute on function public.agent_oauth_import_supabase_clients(text[]) to service_role;
