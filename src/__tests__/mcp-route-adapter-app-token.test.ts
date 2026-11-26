import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { hashAgentSecret } from '@/lib/agent-oauth-tokens';
import { IDENTITY_ADMISSION_HEADER } from '@/lib/identity-admission-assertion';
import { createMcpRouteHandlers, type McpRouteDependencies } from '@/lib/mcp-route-adapter-service';
import { MCP_TOOLS, mcpToolsFor, type McpToolServices } from '@/lib/mcp-server-service';
import type { McpSurface } from '@/lib/mcp-surfaces';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';

// The MCP routes behind the app's own authorization server
// (docs/plans/agent-token-broker-plan-2026-11-26.md): which tokens are read under each value of
// MCP_AUTHORIZATION_SERVER, and what the tools are given once an opaque token is admitted. The
// Supabase path's own cases stay in mcp-route-adapter-service.test.ts.

const SITE = 'https://magicbooklet.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const APP_TOKEN = `mbat_${'t'.repeat(43)}`;
const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
const METADATA_URL = `${SITE}/.well-known/oauth-protected-resource/api/mcp`;

const ADMITTED = {
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

const AGENT_CLAIMS = { sub: USER_ID, aud: 'authenticated', role: 'authenticated', is_anonymous: false, client_id: 'client-claude' };
const ACTIVE = { state: 'active', session_valid: true, banned: false, created_at: '2026-11-09T00:00:00Z' };

function rpc(method: string, params?: Record<string, unknown>, options: { token?: string; path?: string } = {}) {
  return new NextRequest(`${SITE}${options.path ?? '/api/mcp'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${options.token ?? APP_TOKEN}`,
      [IDENTITY_ADMISSION_HEADER]: 'forged',
      'x-idempotency-key': 'kept-header',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
}

function harness(overrides: { mode?: string; admission?: unknown; admissionError?: unknown; surface?: McpSurface } = {}) {
  const insert = vi.fn(async () => ({ error: null }));
  const admissionRpc = vi.fn(async () => (
    overrides.admissionError ? { data: null, error: overrides.admissionError } : { data: overrides.admission === undefined ? ADMITTED : overrides.admission, error: null }
  ));
  const admin = {
    rpc: admissionRpc,
    from: vi.fn((table: string) => {
      if (table !== 'agent_tool_calls') throw new Error(`unexpected table ${table}`);
      return { insert };
    }),
  } as unknown as SupabaseClient;
  // The per-request client: its Auth is never asked, the admitted identity is registered on it.
  const requestClients: Array<{ auth: { getUser: ReturnType<typeof vi.fn> } }> = [];
  const createRequestServiceClient = vi.fn(() => {
    const client = { auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: new Error('not expected') })) } };
    requestClients.push(client);
    return client as unknown as SupabaseClient;
  });
  const supabaseIdentity = {
    auth: { getClaims: vi.fn(async () => ({ data: { claims: AGENT_CLAIMS }, error: null })) },
    rpc: vi.fn(async () => ({ data: ACTIVE, error: null })),
  };
  const createUserClient = vi.fn(() => ({ auth: { getUser: vi.fn() } }) as unknown as SupabaseClient);
  // Each takes its one argument by name so a test can read what the tool handed it.
  const listOwnerGenerationsForRoute = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ generations: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }));
  const enhancePromptForUser = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ ok: true as const, enhancedPrompt: 'better', cost: 1, remainingCredits: 9 }));
  const log = vi.fn();
  const deferred: Array<Promise<unknown>> = [];
  const dependencies: McpRouteDependencies = {
    ...(overrides.surface ? { surface: overrides.surface } : {}),
    identity: { createUserClient: () => supabaseIdentity },
    createUserClient: createUserClient as never,
    createServiceClient: () => admin,
    createRequestServiceClient: createRequestServiceClient as never,
    siteUrl: SITE,
    kieApiKey: 'kie-test-key',
    log,
    runAfterResponse: (task) => { deferred.push(task()); },
    env: overrides.mode === undefined ? { MCP_AUTHORIZATION_SERVER: 'app' } : { MCP_AUTHORIZATION_SERVER: overrides.mode },
    services: {
      listOwnerGenerationsForRoute: listOwnerGenerationsForRoute as unknown as McpToolServices['listOwnerGenerationsForRoute'],
      enhancePromptForUser: enhancePromptForUser as unknown as McpToolServices['enhancePromptForUser'],
      enforceBackendRateLimit: vi.fn(async () => undefined) as unknown as McpToolServices['enforceBackendRateLimit'],
    },
  };
  return {
    handlers: createMcpRouteHandlers(dependencies),
    admin,
    admissionRpc,
    insert,
    log,
    supabaseIdentity,
    createUserClient,
    createRequestServiceClient,
    requestClients,
    listOwnerGenerationsForRoute,
    enhancePromptForUser,
    settled: async () => { await Promise.all(deferred); },
  };
}

describe('MCP routes: which token is read', () => {
  it('reads no app token while Supabase is the authorization server', async () => {
    for (const mode of ['supabase', '']) {
      const { handlers, admissionRpc, supabaseIdentity } = harness({ mode });
      const response = await handlers.POST(rpc('tools/list'));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain(`Bearer resource_metadata="${METADATA_URL}", error="invalid_token"`);
      expect(admissionRpc).not.toHaveBeenCalled();
      expect(supabaseIdentity.auth.getClaims).not.toHaveBeenCalled();
    }
  });

  it('reads no JWT once the app is the authorization server: an agent\'s or a session\'s', async () => {
    const { handlers, admissionRpc, supabaseIdentity, createUserClient } = harness({ mode: 'app' });
    const response = await handlers.POST(rpc('tools/list', undefined, { token: JWT }));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`Bearer resource_metadata="${METADATA_URL}", error="invalid_token"`);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    // Refused before anything read it: no signature check, no lifecycle call, no token lookup.
    expect(supabaseIdentity.auth.getClaims).not.toHaveBeenCalled();
    expect(supabaseIdentity.rpc).not.toHaveBeenCalled();
    expect(admissionRpc).not.toHaveBeenCalled();
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it('takes both during the proving stage, each by its own path', async () => {
    const app = harness({ mode: 'both' });
    expect((await app.handlers.POST(rpc('tools/list'))).status).toBe(200);
    expect(app.admissionRpc).toHaveBeenCalledTimes(1);
    expect(app.supabaseIdentity.auth.getClaims).not.toHaveBeenCalled();

    const supabase = harness({ mode: 'both' });
    expect((await supabase.handlers.POST(rpc('tools/list', undefined, { token: JWT }))).status).toBe(200);
    expect(supabase.supabaseIdentity.auth.getClaims).toHaveBeenCalledTimes(1);
    expect(supabase.admissionRpc).not.toHaveBeenCalled();
  });

  it('refuses a malformed Authorization header the same way in every mode', async () => {
    for (const mode of ['supabase', 'both', 'app']) {
      const { handlers, admissionRpc } = harness({ mode });
      const request = new NextRequest(`${SITE}/api/mcp`, { method: 'POST', headers: { authorization: `Token ${APP_TOKEN}`, 'content-type': 'application/json' }, body: '{}' });
      const response = await handlers.POST(request);
      expect(response.status).toBe(401);
      expect(admissionRpc).not.toHaveBeenCalled();
    }
  });
});

describe('MCP routes: an admitted app token', () => {
  it('serves the tools after one lookup by the token\'s hash', async () => {
    const { handlers, admissionRpc } = harness();
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(200);
    expect(((await response.json()).result.tools as unknown[]).length).toBe(MCP_TOOLS.length);
    expect(admissionRpc).toHaveBeenCalledTimes(1);
    expect(admissionRpc).toHaveBeenCalledWith('agent_oauth_token_admission', { p_token_hash: hashAgentSecret(APP_TOKEN) });
  });

  it('runs a tool as the account, on a client of the request\'s own that knows who was admitted', async () => {
    const { handlers, admin, listOwnerGenerationsForRoute, requestClients, createRequestServiceClient, createUserClient, insert, settled } = harness();
    const response = await handlers.POST(rpc('tools/call', { name: 'list_creations', arguments: {} }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).not.toBe(true);

    const call = listOwnerGenerationsForRoute.mock.calls[0][0] as { userId: string; supabase: SupabaseClient };
    expect(call.userId).toBe(USER_ID);
    // Never the shared service client: an identity registered on that would leak across requests.
    expect(call.supabase).not.toBe(admin);
    expect(call.supabase).toBe(requestClients[0]);
    expect(createRequestServiceClient).toHaveBeenCalledTimes(1);
    // No JWT client is built: there is no JWT.
    expect(createUserClient).not.toHaveBeenCalled();

    // What the services ask of it: the admitted account, with no call to Auth.
    const { data, error } = await getVerifiedAuthUserResult(call.supabase);
    expect(error).toBeNull();
    expect(data.user).toMatchObject({ id: USER_ID, email: 'creator@example.test', is_anonymous: false, created_at: '2026-10-01T00:00:00Z' });
    expect(requestClients[0].auth.getUser).not.toHaveBeenCalled();
    // And the shared client says nothing of anyone.
    const shared = { auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } };
    await getVerifiedAuthUserResult(shared);
    expect(shared.auth.getUser).toHaveBeenCalledTimes(1);

    await settled();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: USER_ID, client_id: 'client-claude', tool: 'list_creations', ok: true }));
  });

  it('hands the services a request without the token or any assertion the caller sent', async () => {
    const { handlers, enhancePromptForUser } = harness();
    const response = await handlers.POST(rpc('tools/call', { name: 'enhance_prompt', arguments: { prompt: 'a cat', medium: 'image', model_id: 'nano-banana-2' } }));
    expect(response.status).toBe(200);
    const { request, userId } = enhancePromptForUser.mock.calls[0][0] as { request: Request; userId: string };
    expect(userId).toBe(USER_ID);
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.headers.get(IDENTITY_ADMISSION_HEADER)).toBeNull();
    // Everything else the caller sent is still there.
    expect(request.headers.get('x-idempotency-key')).toBe('kept-header');
    expect(new URL(request.url).pathname).toBe('/api/mcp');
  });

  it('makes a client per request, each with its own account', async () => {
    const { handlers, listOwnerGenerationsForRoute, requestClients } = harness();
    await handlers.POST(rpc('tools/call', { name: 'list_creations', arguments: {} }));
    await handlers.POST(rpc('tools/call', { name: 'list_creations', arguments: {} }));
    expect(requestClients).toHaveLength(2);
    const [first, second] = listOwnerGenerationsForRoute.mock.calls.map(([input]) => (input as { supabase: unknown }).supabase);
    expect(first).not.toBe(second);
  });

  it('serves the 2026-07-28 envelope the same way', async () => {
    const { handlers } = harness({ surface: 'posts' });
    const request = new NextRequest(`${SITE}/api/mcp/posts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${APP_TOKEN}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' }, [CLIENT_CAPABILITIES_META_KEY]: {} } },
      }),
    });
    const response = await handlers.POST(request);
    expect(response.status).toBe(200);
    const tools = (await response.json()).result.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(mcpToolsFor('posts').map((tool) => tool.name).sort());
  });

  it('never logs the token', async () => {
    const { handlers, log, settled } = harness();
    await handlers.POST(rpc('tools/call', { name: 'list_creations', arguments: {} }));
    await settled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(APP_TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain(APP_TOKEN.slice(5));
  });
});

describe('MCP routes: a refused app token', () => {
  it('challenges an unknown, expired or revoked token so the client signs in again', async () => {
    const { handlers, createRequestServiceClient } = harness({ admission: null });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}", error="invalid_token", error_description="The access token is invalid or has expired. Sign in again."`,
    );
    expect(createRequestServiceClient).not.toHaveBeenCalled();
    const posts = await harness({ admission: null, surface: 'posts' }).handlers.POST(rpc('tools/list', undefined, { path: '/api/mcp/posts' }));
    expect(posts.headers.get('www-authenticate')).toContain(`${METADATA_URL}/posts`);
  });

  it('answers each account state as the proxy would, and serves nothing', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ state: 'deleting' }, 409, 'ACCOUNT_DELETING'],
      [{ state: 'merged' }, 409, 'SESSION_MERGED'],
      [{ is_anonymous: true }, 403, 'REGISTRATION_REQUIRED'],
      [{ state: null }, 503, 'IDENTITY_CHECK_UNAVAILABLE'],
    ];
    for (const [change, status, code] of cases) {
      const { handlers, listOwnerGenerationsForRoute } = harness({ admission: { ...ADMITTED, ...change } });
      const response = await handlers.POST(rpc('tools/call', { name: 'list_creations', arguments: {} }));
      expect(response.status, code).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.json()).resolves.toMatchObject({ code });
      expect(listOwnerGenerationsForRoute).not.toHaveBeenCalled();
    }
    const banned = await harness({ admission: { ...ADMITTED, banned: true } }).handlers.POST(rpc('tools/list'));
    expect(banned.status).toBe(401);
  });

  it('keeps a posting grant off the full server', async () => {
    const posting = { ...ADMITTED, surface: 'posts' };
    const refused = await harness({ admission: posting }).handlers.POST(rpc('tools/list'));
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ code: 'AGENT_SURFACE_NOT_ALLOWED' });
    const served = await harness({ admission: posting, surface: 'posts' }).handlers.POST(rpc('tools/list', undefined, { path: '/api/mcp/posts' }));
    expect(served.status).toBe(200);
    expect(((await served.json()).result.tools as unknown[]).length).toBe(mcpToolsFor('posts').length);
  });

  it('answers 503 when the lookup fails: an outage is not a sign-out', async () => {
    const { handlers } = harness({ admissionError: { message: 'connection refused' } });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(503);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('still answers the kill switch first', async () => {
    const handlers = createMcpRouteHandlers({ env: { MCP_AUTHORIZATION_SERVER: 'app', MCP_SERVER_DISABLED: '1' } });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'MCP_SERVER_DISABLED' });
  });
});
