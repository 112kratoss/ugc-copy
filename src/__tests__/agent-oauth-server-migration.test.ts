import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261126121704_agent_oauth_server.sql', 'utf8');

const TABLES = ['agent_oauth_clients', 'agent_oauth_grants', 'agent_oauth_authorizations', 'agent_oauth_tokens'] as const;
const FUNCTIONS = [
  'agent_oauth_revoke_grant(uuid, text)',
  'agent_oauth_revoke_grants(uuid, text, text)',
  'agent_oauth_revoke_token(text, text)',
  'agent_oauth_consume_code(text)',
  'agent_oauth_issue_grant(text, text, text, integer, integer)',
  'agent_oauth_rotate_refresh_token(text, text, text, text, integer, integer, integer)',
  'agent_oauth_token_admission(text)',
  'agent_oauth_purge_expired()',
  'agent_oauth_import_supabase_clients(text[])',
] as const;

// The app's own authorization server for MCP (docs/plans/agent-token-broker-plan-2026-11-26.md):
// what the migration creates, and who may touch it.
describe('agent_oauth_server migration', () => {
  it('creates the four tables', () => {
    for (const table of TABLES) expect(sql).toContain(`create table public.${table} (`);
    expect(sql.match(/create table /gu)).toHaveLength(4);
  });

  it('keeps every table to the service role: RLS on, no policy, no grant to a Data API role', () => {
    for (const table of TABLES) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`revoke all on public.${table} from public, anon, authenticated, service_role`);
    }
    expect(sql).not.toMatch(/create policy/iu);
    expect(sql).not.toMatch(/^grant [^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/imu);
  });

  it('gives the service role only what the app does directly; grants and tokens change through functions', () => {
    expect(sql).toContain('grant select, insert, update on public.agent_oauth_clients to service_role');
    expect(sql).toContain('grant select on public.agent_oauth_grants to service_role');
    expect(sql).toContain('grant select, insert, update on public.agent_oauth_authorizations to service_role');
    expect(sql).not.toMatch(/grant [^;]*on public\.agent_oauth_tokens/u);
    expect(sql).not.toMatch(/grant [^;]*delete[^;]*on public\.agent_oauth_/u);
  });

  it('stores hashes, never secrets: every secret column is held to a 43-character digest', () => {
    for (const column of ['client_secret_hash', 'consent_token_hash', 'code_hash']) {
      expect(sql).toMatch(new RegExp(`${column} text[^,]*check \\(${column} is null or ${column} ~ '\\^\\[A-Za-z0-9_-\\]\\{43\\}\\$'\\)`, 'u'));
    }
    expect(sql).toContain("token_hash text primary key check (token_hash ~ '^[A-Za-z0-9_-]{43}$')");
    expect(sql).toContain("code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$')");
    expect(sql).not.toMatch(/\b(access_token|refresh_token|client_secret|consent_token|code) text\b/u);
  });

  it('ties grants and tokens to their account and client, so deleting either removes them', () => {
    expect(sql).toMatch(/create table public\.agent_oauth_grants \([^;]*user_id uuid not null references auth\.users\(id\) on delete cascade/u);
    expect(sql).toMatch(/create table public\.agent_oauth_grants \([^;]*client_id text not null references public\.agent_oauth_clients\(client_id\) on delete cascade/u);
    expect(sql).toContain('grant_id uuid not null references public.agent_oauth_grants(id) on delete cascade');
    const authorizations = sql.slice(sql.indexOf('create table public.agent_oauth_authorizations'), sql.indexOf('create table public.agent_oauth_tokens'));
    expect(authorizations).toContain('user_id uuid references auth.users(id) on delete cascade');
    expect(authorizations).toContain('client_id text not null references public.agent_oauth_clients(client_id) on delete cascade');
  });

  it('holds a client, a grant and a request to the values the server knows', () => {
    expect(sql).toContain("check (token_endpoint_auth_method in ('none', 'client_secret_post', 'client_secret_basic'))");
    expect(sql).toContain("check ((token_endpoint_auth_method = 'none') = (client_secret_hash is null))");
    expect(sql.match(/check \(surface in \('full', 'posts'\)\)/gu)).toHaveLength(3);
    expect(sql).toContain("check (status in ('pending', 'approved', 'denied', 'consumed'))");
    expect(sql).toContain("check (revoked_reason in ('user', 'client', 'reuse', 'code_replay', 'operator'))");
    expect(sql).toContain("check (kind in ('access', 'refresh'))");
    expect(sql).toContain("check (id ~ '^mbar_[A-Za-z0-9_-]{43}$')");
    expect(sql).toContain('code_hash text unique');
  });

  it('defines every function as a definer with an empty search path, for the service role alone', () => {
    const definitions = sql.match(/create function public\.agent_oauth_\w+/gu) ?? [];
    expect(definitions).toHaveLength(FUNCTIONS.length);
    expect(sql.match(/security definer\nset search_path = ''/gu)).toHaveLength(FUNCTIONS.length);
    for (const signature of FUNCTIONS) {
      expect(sql, signature).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`);
      expect(sql, signature).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    expect(sql).not.toMatch(/^grant execute[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/imu);
  });

  it('spends a code once, and revokes the grant of a code presented again', () => {
    const consume = sql.slice(sql.indexOf('create function public.agent_oauth_consume_code'), sql.indexOf('create function public.agent_oauth_issue_grant'));
    expect(consume).toContain('for update');
    expect(consume).toMatch(/if v_authorization\.status = 'consumed' then\s+perform public\.agent_oauth_revoke_grant\(v_authorization\.grant_id, 'code_replay'\)/u);
    expect(consume).toContain("v_authorization.code_expires_at <= now()");
    expect(consume).toMatch(/set status = 'consumed', consumed_at = now\(\)/u);
  });

  it('rotates a refresh token under a lock, and ends the grant on reuse past the grace', () => {
    const rotate = sql.slice(sql.indexOf('create function public.agent_oauth_rotate_refresh_token'), sql.indexOf('create function public.agent_oauth_token_admission'));
    expect(rotate.match(/for update/gu)).toHaveLength(2);
    expect(rotate).toContain('v_grant.client_id <> p_client_id');
    expect(rotate).toMatch(/v_token\.used_at < now\(\) - make_interval\(secs => p_reuse_grace_seconds\) then\s+perform public\.agent_oauth_revoke_grant\(v_grant\.id, 'reuse'\)/u);
    expect(rotate).toContain('set used_at = coalesce(used_at, now())');
  });

  it('admits a token only while its grant, client and account all stand', () => {
    const admission = sql.slice(sql.indexOf('create function public.agent_oauth_token_admission'), sql.indexOf('create function public.agent_oauth_purge_expired'));
    for (const condition of [
      "token.kind = 'access'",
      'token.expires_at > now()',
      'grant_row.revoked_at is null',
      'client.disabled_at is null',
      'account.deleted_at is null',
    ]) {
      expect(admission, condition).toContain(condition);
    }
    for (const field of ["'state', v_row.identity_state", "'banned', v_row.banned", "'is_anonymous', v_row.is_anonymous", "'created_at', v_row.account_created_at"]) {
      expect(admission, field).toContain(field);
    }
  });

  it('ends a grant by deleting its tokens, so access and refresh stop together', () => {
    const revoke = sql.slice(sql.indexOf('create function public.agent_oauth_revoke_grant('), sql.indexOf('create function public.agent_oauth_revoke_grants'));
    expect(revoke).toContain('set revoked_at = now(), revoked_reason = p_reason');
    expect(revoke).toContain('delete from public.agent_oauth_tokens where grant_id = p_grant_id');
  });
});
