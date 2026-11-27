import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261127060127_mobile_client_errors_and_post_create_claims.sql', 'utf8');

// Audit 2026-11-27: errors on phones reach nobody. The app's own reporter sends what it catches to
// POST /api/mobile/client-errors, which the service role writes here for 30 days.
describe('mobile_client_errors migration', () => {
  it('creates the table with the columns the route writes, bounded as the route truncates', () => {
    expect(sql).toContain('create table public.mobile_client_errors');
    expect(sql).toContain('id uuid primary key default gen_random_uuid()');
    expect(sql).toContain('created_at timestamptz not null default now()');
    expect(sql).toContain('user_id uuid references auth.users(id) on delete cascade');
    expect(sql).toContain("platform text not null check (platform in ('ios', 'android'))");
    expect(sql).toContain('app_version text check (app_version is null or char_length(app_version) <= 32)');
    expect(sql).toContain('update_id text check (update_id is null or char_length(update_id) <= 64)');
    expect(sql).toContain('route text check (route is null or char_length(route) <= 200)');
    expect(sql).toContain('fatal boolean not null default false');
    expect(sql).toContain('message text not null check (char_length(message) between 1 and 500)');
    expect(sql).toContain('stack text check (stack is null or char_length(stack) <= 4000)');
    expect(sql).toContain('component_stack text check (component_stack is null or char_length(component_stack) <= 2000)');
  });

  it('indexes the retention sweep and the account cascade', () => {
    expect(sql).toContain('on public.mobile_client_errors (created_at)');
    expect(sql).toContain('on public.mobile_client_errors (user_id) where user_id is not null');
  });

  it('gives no client access under RLS, and the service role only appends and reads', () => {
    expect(sql).toContain('alter table public.mobile_client_errors enable row level security');
    expect(sql).toMatch(/create policy "No client access to mobile_client_errors"\s+on public\.mobile_client_errors for all to anon, authenticated\s+using \(false\)\s+with check \(false\)/u);
    expect(sql.match(/create policy[^\n]*mobile_client_errors/gu)).toHaveLength(1);
    expect(sql).toContain('revoke all on public.mobile_client_errors from public, anon, authenticated, service_role');
    expect(sql).toContain('grant select, insert on public.mobile_client_errors to service_role');
    expect(sql).not.toMatch(/grant [^;]*on public\.mobile_client_errors to (anon|authenticated)/u);
    expect(sql).not.toMatch(/grant [^;]*(update|delete)[^;]*on public\.mobile_client_errors/u);
  });

  it('prunes rows older than 30 days in bounded batches, for the service role alone', () => {
    expect(sql).toContain('create or replace function public.prune_mobile_client_errors(p_limit integer default 5000)');
    expect(sql).toContain("where errors.created_at < now() - interval '30 days'");
    expect(sql).toContain('for update skip locked');
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain('revoke all on function public.prune_mobile_client_errors(integer) from public, anon, authenticated');
    expect(sql).toContain('grant execute on function public.prune_mobile_client_errors(integer) to service_role');
    // A supplementary step: the main retention function is not replaced.
    expect(sql).not.toContain('prune_operational_backend_data(');
  });

  // Audit 2026-11-27, finding 4: the claim a keyed create takes before it writes anything.
  it('creates post_create_claims keyed on the account and the key, service role only, pruned after a day', () => {
    expect(sql).toContain('create table public.post_create_claims');
    expect(sql).toContain('user_id uuid not null references auth.users(id) on delete cascade');
    expect(sql).toContain('idempotency_key uuid not null');
    expect(sql).toContain('post_id uuid not null');
    expect(sql).toContain('claimed_at timestamptz not null default now()');
    expect(sql).toContain('primary key (user_id, idempotency_key)');
    expect(sql).toContain('alter table public.post_create_claims enable row level security');
    expect(sql).toMatch(/create policy "No client access to post_create_claims"\s+on public\.post_create_claims for all to anon, authenticated\s+using \(false\)\s+with check \(false\)/u);
    expect(sql).toContain('revoke all on public.post_create_claims from public, anon, authenticated, service_role');
    expect(sql).toContain('grant select, insert, delete on public.post_create_claims to service_role');
    expect(sql).not.toMatch(/grant [^;]*on public\.post_create_claims to (anon|authenticated)/u);
    expect(sql).toContain('create or replace function public.prune_post_create_claims(p_limit integer default 5000)');
    expect(sql).toContain("where claims.claimed_at < now() - interval '1 day'");
    expect(sql).toContain('grant execute on function public.prune_post_create_claims(integer) to service_role');
  });
});
