import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261109183611_agent_tool_calls.sql', 'utf8');

// The MCP server's audit ledger (plan phase 2): what every agent tool call leaves behind, for the
// owner to read and moderation to list agent posts from.
describe('agent_tool_calls migration', () => {
  it('creates the ledger with the columns the adapter writes and the account cascade', () => {
    expect(sql).toContain('create table public.agent_tool_calls');
    expect(sql).toContain('id uuid primary key default gen_random_uuid()');
    expect(sql).toContain('user_id uuid not null references auth.users(id) on delete cascade');
    expect(sql).toContain("client_id text not null check (client_id <> '')");
    expect(sql).toContain("tool text not null check (tool <> '')");
    expect(sql).toContain('ok boolean not null');
    expect(sql).toContain('code text');
    expect(sql).toContain('generation_id uuid');
    expect(sql).toContain('post_id uuid');
    expect(sql).toContain('cost_credits integer check (cost_credits is null or cost_credits >= 0)');
    expect(sql).toContain('created_at timestamptz not null default now()');
  });

  it('indexes the owner read and the moderation join', () => {
    expect(sql).toContain('on public.agent_tool_calls (user_id, created_at desc)');
    expect(sql).toContain('on public.agent_tool_calls (post_id) where post_id is not null');
  });

  it('is owner-read under RLS and append-only for the service role, per the migrations rule', () => {
    expect(sql).toContain('alter table public.agent_tool_calls enable row level security');
    expect(sql).toMatch(/create policy agent_tool_calls_owner_read\s+on public\.agent_tool_calls\s+for select\s+to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)/u);
    // The one other policy is the identity-state restriction every authenticated grant carries
    // (identity_state_deletion.test.sql): it widens nothing, and no policy lets the Data API write.
    expect(sql).toMatch(/create policy authenticated_identity_active\s+on public\.agent_tool_calls\s+as restrictive\s+for all\s+to authenticated\s+using \(\(select public\.current_identity_is_active\(\)\)\)/u);
    expect(sql.match(/create policy/gu)).toHaveLength(2);
    expect(sql).not.toMatch(/for (insert|update|delete)\b/u);
    // A new table is born with the full service_role grant set; an audit ledger cuts it to select and insert.
    expect(sql).toContain('revoke all on public.agent_tool_calls from public, anon, authenticated, service_role');
    expect(sql).toContain('grant select on public.agent_tool_calls to authenticated');
    expect(sql).toContain('grant select, insert on public.agent_tool_calls to service_role');
    expect(sql).not.toMatch(/grant [^;]*(update|delete)[^;]*agent_tool_calls/u);
  });
});
