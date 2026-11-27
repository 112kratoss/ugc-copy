-- Errors on phones reach somebody (audit 2026-11-27, finding 2 of the app lines: "errors on
-- phones reach nobody"). The app has no crash vendor by choice (a lean launch,
-- ugc-mobile/__tests__/production-release-readiness.test.ts), so its own reporter
-- (ugc-mobile/lib/client-error-report.ts) sends what its error boundary, its global JS error
-- handler and its unhandled-rejection tracker catch to POST /api/mobile/client-errors
-- (src/lib/mobile-client-errors-route-adapter-service.ts), which the service role writes here.
--
-- What a row holds, and nothing else: the error's message, stack and component stack (truncated by
-- the app and again by the server: 500, 4,000 and 2,000 characters), whether it was fatal, the
-- route it happened on (a path, never its query), the app version and OTA update id, the platform,
-- and the account when the report came with a session. No form field, prompt or request body is
-- sent; an error's own text can still quote what it was handed (a server's error message, text a
-- parser could not read), so a message is treated as possibly personal and kept 30 days.
--
-- Rows live 30 days: prune_mobile_client_errors() is a supplementary step of the daily retention
-- run (src/lib/operational-data-retention.ts), beside the share-event prunes, and
-- prune_operational_backend_data is left as it is.

create table public.mobile_client_errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- The account's reports go with the account.
  user_id uuid references auth.users(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  app_version text check (app_version is null or char_length(app_version) <= 32),
  update_id text check (update_id is null or char_length(update_id) <= 64),
  route text check (route is null or char_length(route) <= 200),
  fatal boolean not null default false,
  message text not null check (char_length(message) between 1 and 500),
  stack text check (stack is null or char_length(stack) <= 4000),
  component_stack text check (component_stack is null or char_length(component_stack) <= 2000)
);

comment on table public.mobile_client_errors is
  'JS errors the mobile app caught (error boundary, global handler, unhandled rejections), written by the service role behind POST /api/mobile/client-errors. No client access; rows are pruned after 30 days.';

-- The retention sweep and any read by time.
create index mobile_client_errors_created_idx
  on public.mobile_client_errors (created_at);
-- The cascade on account deletion.
create index mobile_client_errors_user_idx
  on public.mobile_client_errors (user_id) where user_id is not null;

alter table public.mobile_client_errors enable row level security;

-- New tables are born with every service_role privilege. An error log is appended to and read;
-- rows leave only through the prune below, which runs as its owner.
revoke all on public.mobile_client_errors from public, anon, authenticated, service_role;
grant select, insert on public.mobile_client_errors to service_role;

create policy "No client access to mobile_client_errors"
  on public.mobile_client_errors for all to anon, authenticated
  using (false)
  with check (false);

-- Rows older than 30 days, oldest first, at most p_limit (5,000) at a time; the retention run
-- calls again while a batch comes back full.
create or replace function public.prune_mobile_client_errors(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 5000));
  v_deleted integer;
begin
  with victims as (
    select errors.id
    from public.mobile_client_errors as errors
    where errors.created_at < now() - interval '30 days'
    order by errors.created_at, errors.id
    limit v_limit
    for update skip locked
  )
  delete from public.mobile_client_errors as errors
  using victims
  where errors.id = victims.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_mobile_client_errors(integer) from public, anon, authenticated;
grant execute on function public.prune_mobile_client_errors(integer) to service_role;

-- The composer's Idempotency-Key (audit 2026-11-27, finding 4): POST /api/posts takes a claim on
-- (account, key) before it writes anything (src/lib/post-create-route-service.ts). Only the request
-- that inserted the claim creates the post, under an id derived from the account and the key, so
-- two requests with one key never copy media to the same paths or write the same post row. A claim
-- older than the route can run (330 s) belongs to a request that died: the key is then refused and
-- the client makes a new one. Claims are kept a day, then pruned by the daily retention run.

create table public.post_create_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  post_id uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);

comment on table public.post_create_claims is
  'One row per composer create under an Idempotency-Key: the request that inserted it is the one that creates the post. Service role only; pruned after a day.';

create index post_create_claims_claimed_idx
  on public.post_create_claims (claimed_at);

alter table public.post_create_claims enable row level security;

-- Inserted, read and, by the request that holds it after an attempt that made nothing, deleted.
revoke all on public.post_create_claims from public, anon, authenticated, service_role;
grant select, insert, delete on public.post_create_claims to service_role;

create policy "No client access to post_create_claims"
  on public.post_create_claims for all to anon, authenticated
  using (false)
  with check (false);

create or replace function public.prune_post_create_claims(p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 5000), 5000));
  v_deleted integer;
begin
  with victims as (
    select claims.user_id, claims.idempotency_key
    from public.post_create_claims as claims
    where claims.claimed_at < now() - interval '1 day'
    order by claims.claimed_at
    limit v_limit
    for update skip locked
  )
  delete from public.post_create_claims as claims
  using victims
  where claims.user_id = victims.user_id
    and claims.idempotency_key = victims.idempotency_key;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_post_create_claims(integer) from public, anon, authenticated;
grant execute on function public.prune_post_create_claims(integer) to service_role;
