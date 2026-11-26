import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { admitAgentAccessToken } from '@/lib/agent-oauth-admission';
import { hashAgentSecret } from '@/lib/agent-oauth-tokens';
import { MCP_POSTING_ONLY_CLIENT_IDS } from '@/lib/mcp-client-directory';
import {
  buildOAuthAuthorizationServerMetadata,
  createAuthorizationServerMetadataOptionsResponse,
  createAuthorizationServerMetadataResponse,
} from '@/lib/oauth-authorization-server-metadata';

const TOKEN = `mbat_${'k'.repeat(43)}`;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ROW = {
  grant_id: '33333333-3333-4333-8333-333333333333',
  user_id: USER_ID,
  client_id: 'client-claude',
  surface: 'full',
  state: 'active',
  created_at: '2026-10-01T00:00:00Z',
  email: 'creator@example.test',
  is_anonymous: false,
  banned: false,
};

function admin(answer: { data?: unknown; error?: unknown } | (() => never)) {
  const rpc = vi.fn(async () => (typeof answer === 'function' ? answer() : { data: answer.data ?? null, error: answer.error ?? null }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const admit = (row: unknown, surface: 'full' | 'posts' = 'full', token = TOKEN) => {
  const { client, rpc } = admin({ data: row });
  return admitAgentAccessToken(token, { admin: client, surface }).then((admission) => ({ admission, rpc }));
};

// MCP admission of the app's own token (docs/plans/agent-token-broker-plan-2026-11-26.md).
describe('agent access token admission', () => {
  it('admits a live token as its account, looked up by hash in one round trip', async () => {
    const { admission, rpc } = await admit(ROW);
    expect(admission).toEqual({
      ok: true,
      userId: USER_ID,
      clientId: 'client-claude',
      grantId: ROW.grant_id,
      grantSurface: 'full',
      user: {
        id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'creator@example.test', is_anonymous: false,
        app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z',
      },
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('agent_oauth_token_admission', { p_token_hash: hashAgentSecret(TOKEN) });
    // The token itself never travels to the database.
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(TOKEN);
  });

  it('never looks up anything that is not one of its own tokens: a JWT, a refresh token, junk', async () => {
    for (const token of ['eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln', `mbrt_${'k'.repeat(43)}`, 'mbat_short', '', `${TOKEN}x`]) {
      const { admission, rpc } = await admit(ROW, 'full', token);
      expect(admission, token).toMatchObject({ ok: false, status: 401, code: 'UNAUTHORIZED' });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('answers 401 for a token the database does not admit: unknown, expired, revoked, account gone', async () => {
    expect((await admit(null)).admission).toMatchObject({ ok: false, status: 401, code: 'UNAUTHORIZED' });
  });

  it('answers as the proxy does for each account state, in the same order', async () => {
    // Deleting first, even when banned: the account is told it is going, not that it is intact.
    expect((await admit({ ...ROW, state: 'deleting', banned: true })).admission).toMatchObject({ status: 409, code: 'ACCOUNT_DELETING' });
    expect((await admit({ ...ROW, banned: true })).admission).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect((await admit({ ...ROW, state: 'merged', banned: true })).admission).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect((await admit({ ...ROW, state: 'merged' })).admission).toMatchObject({ status: 409, code: 'SESSION_MERGED' });
    expect((await admit({ ...ROW, state: null })).admission).toMatchObject({ status: 503, code: 'IDENTITY_CHECK_UNAVAILABLE' });
    expect((await admit({ ...ROW, state: 'something-new' })).admission).toMatchObject({ status: 503, code: 'IDENTITY_CHECK_UNAVAILABLE' });
    expect((await admit({ ...ROW, is_anonymous: true })).admission).toMatchObject({ status: 403, code: 'REGISTRATION_REQUIRED' });
  });

  it('keeps a posting grant off the full server, and takes a full grant at either', async () => {
    expect((await admit({ ...ROW, surface: 'posts' }, 'full')).admission).toMatchObject({ status: 403, code: 'AGENT_SURFACE_NOT_ALLOWED' });
    expect((await admit({ ...ROW, surface: 'posts' }, 'posts')).admission).toMatchObject({ ok: true, grantSurface: 'posts' });
    expect((await admit(ROW, 'posts')).admission).toMatchObject({ ok: true, grantSurface: 'full' });
    expect((await admit(ROW, 'full')).admission).toMatchObject({ ok: true });
  });

  it('holds a client the code lists as posting-only off the full server, even with a grant that says full', async () => {
    for (const clientId of Object.values(MCP_POSTING_ONLY_CLIENT_IDS)) {
      const mislabelled = { ...ROW, client_id: clientId, surface: 'full' };
      expect((await admit(mislabelled, 'full')).admission).toMatchObject({ status: 403, code: 'AGENT_SURFACE_NOT_ALLOWED' });
      expect((await admit(mislabelled, 'posts')).admission).toMatchObject({ ok: true });
    }
  });

  it('answers 503, never 401, when the database cannot be asked', async () => {
    const failing = admin({ error: { message: 'connection refused' } });
    await expect(admitAgentAccessToken(TOKEN, { admin: failing.client, surface: 'full' })).resolves.toMatchObject({ status: 503, code: 'IDENTITY_CHECK_UNAVAILABLE' });
    const throwing = admin(() => { throw new Error('network'); });
    await expect(admitAgentAccessToken(TOKEN, { admin: throwing.client, surface: 'full' })).resolves.toMatchObject({ status: 503 });
    const odd = admin({ data: 'not an object' });
    await expect(admitAgentAccessToken(TOKEN, { admin: odd.client, surface: 'full' })).resolves.toMatchObject({ status: 503 });
  });
});

describe('authorization server metadata (RFC 8414)', () => {
  const env = { MCP_AUTHORIZATION_SERVER: 'app', NEXT_PUBLIC_SITE_URL: 'https://magicbooklet.test/some/path' };

  it('describes the server the app runs, with the site origin as issuer', () => {
    expect(buildOAuthAuthorizationServerMetadata({ env })).toEqual({
      issuer: 'https://magicbooklet.test',
      authorization_endpoint: 'https://magicbooklet.test/oauth/authorize',
      token_endpoint: 'https://magicbooklet.test/oauth/token',
      revocation_endpoint: 'https://magicbooklet.test/oauth/revoke',
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['mcp'],
      service_documentation: 'https://magicbooklet.test/developers/mcp',
    });
    expect(buildOAuthAuthorizationServerMetadata({ env: { ...env, MCP_AUTHORIZATION_SERVER: 'both' } })?.issuer).toBe('https://magicbooklet.test');
  });

  it('offers no dynamic registration, no implicit flow, no plain PKCE and no iss parameter', () => {
    const metadata = buildOAuthAuthorizationServerMetadata({ env }) as Record<string, unknown>;
    expect(metadata.registration_endpoint).toBeUndefined();
    expect(metadata.authorization_response_iss_parameter_supported).toBeUndefined();
    expect(metadata.code_challenge_methods_supported).not.toContain('plain');
    expect(metadata.response_types_supported).not.toContain('token');
    expect(JSON.stringify(metadata)).not.toContain('supabase');
  });

  it('does not exist while Supabase is the authorization server, or without a site URL', async () => {
    expect(buildOAuthAuthorizationServerMetadata({ env: { NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL } })).toBeNull();
    expect(buildOAuthAuthorizationServerMetadata({ env: { ...env, MCP_AUTHORIZATION_SERVER: 'supabase' } })).toBeNull();
    expect(buildOAuthAuthorizationServerMetadata({ env: { MCP_AUTHORIZATION_SERVER: 'app' } })).toBeNull();
    const off = createAuthorizationServerMetadataResponse({ env: {} });
    expect(off.status).toBe(404);
    expect(off.headers.get('cache-control')).toBe('no-store');
    await expect(off.json()).resolves.toMatchObject({ code: 'AUTHORIZATION_SERVER_NOT_ENABLED' });
  });

  it('is served cross-origin and cached for minutes, so the cutover is read promptly', async () => {
    const response = createAuthorizationServerMetadataResponse({ env });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    await expect(response.json()).resolves.toMatchObject({ issuer: 'https://magicbooklet.test' });
    const options = createAuthorizationServerMetadataOptionsResponse();
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });
});
