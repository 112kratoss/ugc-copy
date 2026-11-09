-- The MCP server's audit table (docs/plans/agent-mcp-server-plan-2026-11-09.md, phase 2): one row
-- per tool call an agent (Claude, ChatGPT, Codex, Cursor, …) made as a signed-in creator through
-- /api/mcp, written by the service role behind the tool's answer
-- (src/lib/mcp-route-adapter-service.ts, src/lib/agent-tool-calls.ts). Moderation lists the posts
-- agents published from it (`npm run ops:moderation -- list --source agent`); a creator may read
-- their own rows. Prompts and results are never written here: a row says which tool, whether it
-- answered, its error code, the creation and the post it was about, and what it charged.
create table public.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The OAuth client the agent's token was issued to (`client_id` claim, src/lib/agent-token.ts).
  client_id text not null check (client_id <> ''),
  tool text not null check (tool <> ''),
  ok boolean not null,
  -- The tool's stable error code where it failed (RATE_LIMITED, NOT_OWNER, …); null for an answer.
  code text,
  generation_id uuid,
  post_id uuid,
  -- Set only where the answer charged the creator (a start, an enhancement), never for a quote,
  -- a failure or a replay under an idempotency key, whose cost was recorded by the first call.
  cost_credits integer check (cost_credits is null or cost_credits >= 0),
  created_at timestamptz not null default now()
);

comment on table public.agent_tool_calls is
  'One row per MCP tool call an agent made as a creator; written by the service role, read by the owner and by moderation.';

create index agent_tool_calls_user_created_idx
  on public.agent_tool_calls (user_id, created_at desc);
create index agent_tool_calls_post_idx
  on public.agent_tool_calls (post_id) where post_id is not null;
-- The moderation listing's read: the posts agents published, newest first.
create index agent_tool_calls_publish_idx
  on public.agent_tool_calls (created_at desc)
  where tool = 'publish_post' and ok and post_id is not null;

alter table public.agent_tool_calls enable row level security;

-- A creator reads their own rows (the Connected apps section may show them one day); nobody
-- writes through the Data API. The service role appends; an audit ledger is never updated or
-- deleted, so the full grant set a new table is born with is cut to select and insert.
create policy agent_tool_calls_owner_read
  on public.agent_tool_calls
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Every table the authenticated role may touch carries this (identity_state_deletion.test.sql
-- holds the invariant): an account being deleted or merged away sees nothing through a token it
-- still holds.
create policy authenticated_identity_active
  on public.agent_tool_calls
  as restrictive
  for all
  to authenticated
  using ((select public.current_identity_is_active()))
  with check ((select public.current_identity_is_active()));

revoke all on public.agent_tool_calls from public, anon, authenticated, service_role;
grant select on public.agent_tool_calls to authenticated;
grant select, insert on public.agent_tool_calls to service_role;
