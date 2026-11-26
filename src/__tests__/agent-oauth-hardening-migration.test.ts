import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261126151150_agent_oauth_hardening.sql', 'utf8');
const between = (from: string, to: string) => sql.slice(sql.indexOf(from), sql.indexOf(to, sql.indexOf(from) + from.length));

// The app's authorization server after its security review
// (docs/plans/agent-token-broker-plan-2026-11-26.md, "After the security review"). The rules
// themselves run against Postgres in supabase/tests/database/agent_oauth_hardening.test.sql.
describe('agent_oauth_hardening migration', () => {
  it('holds every stored redirect URI to a web address, in the table itself', () => {
    const check = between('create function public.agent_oauth_redirect_uri_ok', 'create function public.agent_oauth_redirect_uris_ok');
    expect(check).toContain("p_uri !~ '[[:space:][:cntrl:]#]'");
    expect(check).toContain("'^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'");
    expect(check).toContain("'^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?(/[^[:space:]]*)?$'");
    expect(sql).toMatch(/alter table public\.agent_oauth_clients\s+add constraint agent_oauth_clients_redirect_uris_are_web\s+check \(public\.agent_oauth_redirect_uris_ok\(redirect_uris\)\)/u);
    expect(sql).toMatch(/alter table public\.agent_oauth_authorizations\s+add constraint agent_oauth_authorizations_redirect_uri_is_web\s+check \(public\.agent_oauth_redirect_uri_ok\(redirect_uri\)\)/u);
  });

  it('skips, in the import, a client the table would refuse', () => {
    const imported = sql.slice(sql.indexOf('create or replace function public.agent_oauth_import_supabase_clients'));
    expect(imported).toMatch(/if not public\.agent_oauth_redirect_uris_ok\(v_uris\) then\s+v_skipped := v_skipped \|\| jsonb_build_object\('client_id', v_client\.client_id, 'reason', 'redirect_uris_unusable'\)/u);
  });

  it('binds a grant to the password it was given under, by a digest and never the stored hash', () => {
    expect(sql).toContain("select encode(sha256(convert_to(coalesce(p_encrypted_password, ''), 'UTF8')), 'hex')");
    expect(sql).toContain('alter table public.agent_oauth_grants add column credential_fingerprint text');
    expect(sql).toContain('alter table public.agent_oauth_grants alter column credential_fingerprint set not null');
    expect(sql).not.toMatch(/credential_fingerprint\s*=\s*account\.encrypted_password/u);
    expect(sql).toContain("'credentials_changed', 'superseded'");
  });

  it('ends a grant whose password has changed, at admission and at a refresh', () => {
    const admission = between('create or replace function public.agent_oauth_token_admission', 'create or replace function public.agent_oauth_purge_expired');
    expect(admission).toMatch(/if v_row\.current_fingerprint is distinct from v_row\.credential_fingerprint then\s+perform public\.agent_oauth_revoke_grant\(v_row\.grant_id, 'credentials_changed'\);\s+return null;/u);
    const rotate = between('create or replace function public.agent_oauth_rotate_refresh_token', 'create or replace function public.agent_oauth_token_admission');
    expect(rotate).toMatch(/if v_fingerprint is distinct from v_grant\.credential_fingerprint then\s+perform public\.agent_oauth_revoke_grant\(v_grant\.id, 'credentials_changed'\);/u);
  });

  it('refreshes a grant twelve times an hour, and tells the next to wait without touching its token', () => {
    const rotate = between('create or replace function public.agent_oauth_rotate_refresh_token', 'create or replace function public.agent_oauth_token_admission');
    const limit = rotate.indexOf("created_at > now() - interval '1 hour') >= 12");
    expect(limit).toBeGreaterThan(0);
    expect(rotate).toContain("return jsonb_build_object('outcome', 'rate_limited'");
    // Refused before the presented token is marked used or anything is inserted.
    expect(limit).toBeLessThan(rotate.indexOf('set used_at = coalesce(used_at, now())'));
    expect(limit).toBeLessThan(rotate.indexOf('insert into public.agent_oauth_tokens'));
    // And after reuse detection: a copied token is still caught when the grant is at its limit.
    expect(limit).toBeGreaterThan(rotate.indexOf("'reuse'"));
    // The lock order the first migration's fix gave it is kept.
    expect(rotate.indexOf('from public.agent_oauth_grants')).toBeLessThan(rotate.lastIndexOf('from public.agent_oauth_tokens\n   where token_hash = p_refresh_hash'));
  });

  it('keeps twenty live grants per account and client, ending the oldest', () => {
    const issue = between('create or replace function public.agent_oauth_issue_grant', 'create or replace function public.agent_oauth_rotate_refresh_token');
    expect(issue).toMatch(/order by created_at desc, id desc\s+offset 20\s+loop\s+perform public\.agent_oauth_revoke_grant\(v_old\.id, 'superseded'\);/u);
    expect(issue).toContain('insert into public.agent_oauth_grants (user_id, client_id, surface, credential_fingerprint)');
    // And twenty ended ones.
    expect(issue).toMatch(/and revoked_at is not null\s+order by revoked_at desc, id desc\s+offset 20/u);
  });

  it('changes the tables in the order the functions lock them, so it waits for traffic and does not deadlock with it', () => {
    const authorizations = sql.indexOf('alter table public.agent_oauth_authorizations');
    const grants = sql.indexOf('alter table public.agent_oauth_grants');
    const clients = sql.indexOf('alter table public.agent_oauth_clients');
    expect(authorizations).toBeGreaterThan(0);
    expect(authorizations).toBeLessThan(grants);
    expect(grants).toBeLessThan(clients);
    expect(sql).toMatch(/create index agent_oauth_grants_revoked_idx\s+on public\.agent_oauth_grants \(revoked_at\) where revoked_at is not null/u);
  });

  it('purges grants a month after they were revoked', () => {
    const purge = between('create or replace function public.agent_oauth_purge_expired', 'create or replace function public.agent_oauth_import_supabase_clients');
    expect(purge).toContain("where revoked_at < now() - interval '30 days'");
    expect(purge.match(/limit 500/gu)).toHaveLength(3);
  });

  it('leaves every function a definer with an empty search path, and opens nothing to a Data API role', () => {
    const replaced = sql.match(/create or replace function public\.agent_oauth_\w+/gu) ?? [];
    expect(replaced).toHaveLength(5);
    expect(sql.match(/security definer\nset search_path = ''/gu)).toHaveLength(5);
    // The three pure checks: no definer, an empty search path, the service role alone.
    for (const signature of ['agent_oauth_redirect_uri_ok(text)', 'agent_oauth_redirect_uris_ok(text[])', 'agent_oauth_credential_fingerprint(text)']) {
      expect(sql, signature).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`);
      expect(sql, signature).toContain(`grant execute on function public.${signature} to service_role;`);
    }
    expect(sql).not.toMatch(/^grant [^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/imu);
    expect(sql).not.toMatch(/create policy/iu);
  });
});
