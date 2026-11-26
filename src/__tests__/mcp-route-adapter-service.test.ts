import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { hashAgentSecret } from '@/lib/agent-oauth-tokens';
import { IDENTITY_ADMISSION_HEADER } from '@/lib/identity-admission-assertion';
import {
  bearerChallenge,
  createMcpRouteHandlers,
  isMcpServerDisabled,
  type McpRouteDependencies,
} from '@/lib/mcp-route-adapter-service';
import { MCP_POSTING_ONLY_CLIENT_IDS } from '@/lib/mcp-client-directory';
import { MCP_TOOLS, mcpToolsFor, type McpToolServices } from '@/lib/mcp-server-service';
import type { McpSurface } from '@/lib/mcp-surfaces';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';

const SITE = 'https://magicbooklet.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const GENERATION_ID = '22222222-2222-4222-8222-222222222222';
const METADATA_URL = `${SITE}/.well-known/oauth-protected-resource/api/mcp`;
const POSTS_METADATA_URL = `${SITE}/.well-known/oauth-protected-resource/api/mcp/posts`;

/** The app's own access token (`agent-oauth-tokens.ts`); the MCP routes take no other. */
const APP_TOKEN = `mbat_${'t'.repeat(43)}`;
/** A JWT, an app session's or a Supabase agent's: refused before anything reads it. */
const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4IiwiY2xpZW50X2lkIjoiYyJ9.c2lnbmF0dXJl';

/** The admission lookup's answer for a live grant (`agent_oauth_token_admission`). */
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
const POSTING_GRANT = { ...ADMITTED, client_id: MCP_POSTING_ONLY_CLIENT_IDS.claudeDirectory, surface: 'posts' };

function rpc(method: string, params?: Record<string, unknown>, options: { token?: string | null; id?: number; path?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    [IDENTITY_ADMISSION_HEADER]: 'forged',
  };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? APP_TOKEN}`;
  return new NextRequest(`${SITE}${options.path ?? '/api/mcp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method, ...(params ? { params } : {}) }),
  });
}

/** A request in the 2026-07-28 envelope: the version, the client and its capabilities ride in `_meta`, with no handshake. */
function modernRpc(method: string, params: Record<string, unknown> = {}, options: { path?: string; id?: number } = {}) {
  return new NextRequest(`${SITE}${options.path ?? '/api/mcp'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${APP_TOKEN}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
}

function summaryPayload() {
  return {
    generations: [{
      id: GENERATION_ID,
      status: 'succeeded',
      category: 'image',
      model: 'img-1',
      prompt: 'a red bicycle at dawn',
      created_at: '2026-11-09T10:00:00Z',
      completed_at: '2026-11-09T10:00:30Z',
      cost: 19,
      refunded: false,
      preview_url: 'https://cdn.magicbooklet.test/preview.jpg',
      linked_post_id: null,
    }],
    pagination: { limit: 20, hasMore: false, nextCursor: null },
  };
}

/** The tools' per-request client: it must never need GoTrue, since the admitted identity is registered on it. */
function routeClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null as User | null }, error: new Error('not expected') as unknown })),
    },
  };
}

function harness(overrides: {
  /** The admission lookup's answer: a live grant's row unless said; null for no live grant. */
  admission?: Record<string, unknown> | null;
  env?: Record<string, string | undefined>;
  services?: Partial<McpToolServices>;
  /** The audit insert's answer; an error here must never reach the agent. */
  auditInsert?: () => Promise<{ error: unknown }>;
  /** Which server the route is; the full one unless said. */
  surface?: McpSurface;
} = {}) {
  const admissionRpc = vi.fn(async () => ({ data: overrides.admission === undefined ? ADMITTED : overrides.admission, error: null }));
  const requestClients: Array<ReturnType<typeof routeClient>> = [];
  const createRequestServiceClient = vi.fn(() => {
    const client = routeClient();
    requestClients.push(client);
    return client as unknown as SupabaseClient;
  });
  const insert = vi.fn(overrides.auditInsert ?? (async () => ({ error: null })));
  const from = vi.fn((table: string) => {
    if (table !== 'agent_tool_calls') throw new Error(`unexpected table ${table}`);
    return { insert };
  });
  const admin = { from, rpc: admissionRpc } as unknown as SupabaseClient;
  const log = vi.fn();
  // The route's `after`: every task is kept so a test can wait for the audit row behind the answer.
  const deferred: Array<Promise<unknown>> = [];
  const runAfterResponse = vi.fn((task: () => Promise<unknown>) => { deferred.push(task()); });
  const listOwnerGenerationsForRoute = vi.fn(async () => summaryPayload());
  const dependencies: McpRouteDependencies = {
    ...(overrides.surface ? { surface: overrides.surface } : {}),
    createServiceClient: () => admin,
    createRequestServiceClient: createRequestServiceClient as never,
    siteUrl: SITE,
    kieApiKey: 'kie-test-key',
    log,
    runAfterResponse,
    env: overrides.env ?? {},
    services: {
      listOwnerGenerationsForRoute: listOwnerGenerationsForRoute as unknown as McpToolServices['listOwnerGenerationsForRoute'],
      enforceBackendRateLimit: vi.fn(async () => undefined) as unknown as McpToolServices['enforceBackendRateLimit'],
      ...overrides.services,
    },
  };
  return {
    handlers: createMcpRouteHandlers(dependencies),
    admissionRpc,
    createRequestServiceClient,
    requestClients,
    log,
    listOwnerGenerationsForRoute,
    insert,
    runAfterResponse,
    settled: async () => { await Promise.all(deferred); },
  };
}

describe('MCP route adapter', () => {
  it('reads the kill switch as 1 or true and nothing else', () => {
    expect(isMcpServerDisabled({ MCP_SERVER_DISABLED: '1' })).toBe(true);
    expect(isMcpServerDisabled({ MCP_SERVER_DISABLED: 'true' })).toBe(true);
    expect(isMcpServerDisabled({ MCP_SERVER_DISABLED: '0' })).toBe(false);
    expect(isMcpServerDisabled({ MCP_SERVER_DISABLED: '' })).toBe(false);
    expect(isMcpServerDisabled({})).toBe(false);
  });

  it('answers 503 with Retry-After from the kill switch before reading any token, on every method', async () => {
    const { handlers, admissionRpc, createRequestServiceClient } = harness({ env: { MCP_SERVER_DISABLED: '1' } });
    for (const response of [
      await handlers.POST(rpc('tools/list')),
      await handlers.GET(),
      await handlers.DELETE(),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('300');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.json()).resolves.toMatchObject({ code: 'MCP_SERVER_DISABLED' });
    }
    expect(admissionRpc).not.toHaveBeenCalled();
    expect(createRequestServiceClient).not.toHaveBeenCalled();
  });

  it('answers GET and DELETE 405: no SSE streams and no sessions', async () => {
    const { handlers } = harness();
    for (const response of [await handlers.GET(), await handlers.DELETE()]) {
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      await expect(response.json()).resolves.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    }
  });

  it('challenges a missing token with the protected-resource metadata, before any lookup', async () => {
    const { handlers, admissionRpc } = harness();
    const response = await handlers.POST(rpc('tools/list', undefined, { token: null }));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}", error="invalid_token", error_description="Sign in to Magicbooklet to use this server."`,
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(admissionRpc).not.toHaveBeenCalled();
  });

  it('challenges a token with no live grant the same way, after one lookup by its hash', async () => {
    const { handlers, admissionRpc, createRequestServiceClient } = harness({ admission: null });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`Bearer resource_metadata="${METADATA_URL}", error="invalid_token"`);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(admissionRpc).toHaveBeenCalledTimes(1);
    expect(admissionRpc).toHaveBeenCalledWith('agent_oauth_token_admission', { p_token_hash: hashAgentSecret(APP_TOKEN) });
    expect(createRequestServiceClient).not.toHaveBeenCalled();
  });

  it("builds the challenge's metadata URL from the site origin", () => {
    expect(bearerChallenge('https://magicbooklet.com', 'Say "hi"')).toBe(
      'Bearer resource_metadata="https://magicbooklet.com/.well-known/oauth-protected-resource/api/mcp", error="invalid_token", error_description="Say \'hi\'"',
    );
  });

  it('refuses a guest 403 REGISTRATION_REQUIRED, as the proxy would', async () => {
    const { handlers, createRequestServiceClient } = harness({ admission: { ...ADMITTED, is_anonymous: true } });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    expect(createRequestServiceClient).not.toHaveBeenCalled();
  });

  it('refuses a JWT, an app session\'s or an agent\'s, with the challenge and before any lookup', async () => {
    const { handlers, admissionRpc, createRequestServiceClient } = harness();
    const response = await handlers.POST(rpc('tools/list', undefined, { token: JWT }));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('www-authenticate')).toContain(`Bearer resource_metadata="${METADATA_URL}", error="invalid_token"`);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(admissionRpc).not.toHaveBeenCalled();
    expect(createRequestServiceClient).not.toHaveBeenCalled();
  });

  it('signs a disconnected agent out: a token whose grant is gone answers 401 with the challenge', async () => {
    // Disconnecting, signing out everywhere or a password change ends the grant and deletes its
    // tokens, so the lookup finds no live row at the agent's next call.
    const { handlers, createRequestServiceClient } = harness({ admission: null });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}", error="invalid_token", error_description="The access token is invalid or has expired. Sign in again."`,
    );
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(createRequestServiceClient).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...ADMITTED, state: 'merged' }, 409, 'SESSION_MERGED'],
    [{ ...ADMITTED, state: 'deleting' }, 409, 'ACCOUNT_DELETING'],
    [{ ...ADMITTED, state: 'unreadable' }, 503, 'IDENTITY_CHECK_UNAVAILABLE'],
    [{ ...ADMITTED, banned: true }, 401, 'UNAUTHORIZED'],
  ])('passes the admission\'s other refusals through (%j)', async (admission, status, code) => {
    const { handlers } = harness({ admission });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
    if (status === 401) expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('answers an agent\'s initialize and tools/list as one JSON body each, with every tool listed', async () => {
    const { handlers } = harness();
    const initialized = await handlers.POST(rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    }));
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('content-type')).toContain('application/json');
    const initBody = await initialized.json();
    expect(initBody).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(initBody.result.serverInfo.name).toBe('magicbooklet');
    expect(initBody.result.instructions).toContain('quote_generation');
    expect(initialized.headers.get('mcp-session-id')).toBeNull();

    const listed = await handlers.POST(rpc('tools/list', undefined, { id: 2 }));
    expect(listed.status).toBe(200);
    expect(listed.headers.get('content-type')).toContain('application/json');
    const body = await listed.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 2 });
    const tools = body.result.tools as Array<{ name: string; title?: string; description?: string; annotations?: Record<string, unknown>; inputSchema: { type: string } }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOLS].map((tool) => tool.name).sort());
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.annotations, tool.name).toBeDefined();
    }
    expect(tools.find((tool) => tool.name === 'create_media')?.annotations).toMatchObject({ destructiveHint: true });
  });

  it('runs the tools as the admitted account, and logs one line per tool call without the prompt', async () => {
    const { handlers, createRequestServiceClient, requestClients, log, listOwnerGenerationsForRoute } = harness();
    const response = await handlers.POST(rpc('tools/call', { name: 'list_creations', arguments: { limit: 5 } }, { id: 7 }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(7);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent.creations[0]).toMatchObject({
      generation_id: GENERATION_ID,
      posted: false,
      creation_url: `${SITE}/creations?generation=${GENERATION_ID}`,
    });

    // The services run on the request's own client, which knows the admitted account without a
    // GoTrue round trip (the request they see has neither the token nor the caller's forged
    // assertion: mcp-route-adapter-app-token.test.ts).
    expect(createRequestServiceClient).toHaveBeenCalledTimes(1);
    const [client] = requestClients;
    expect((await getVerifiedAuthUserResult(client)).data.user?.id).toBe(USER_ID);
    expect(client.auth.getUser).not.toHaveBeenCalled();
    expect(listOwnerGenerationsForRoute).toHaveBeenCalledTimes(1);
    const [{ userId, searchParams, supabase }] = listOwnerGenerationsForRoute.mock.calls[0] as unknown as [{ userId: string; searchParams: URLSearchParams; supabase: unknown }];
    expect(supabase).toBe(client);
    expect(userId).toBe(USER_ID);
    expect(searchParams.get('detail')).toBe('summary');
    expect(searchParams.get('limit')).toBe('5');

    const toolCalls = log.mock.calls.filter(([, event]) => event === 'mcp_tool_call');
    expect(toolCalls).toHaveLength(1);
    const [level, , fields] = toolCalls[0] as [string, string, Record<string, unknown>];
    expect(level).toBe('info');
    expect(fields).toMatchObject({ clientId: 'client-claude', userId: USER_ID, surface: 'full', tool: 'list_creations', outcome: 'ok', code: null, generationId: null, postId: null });
    expect(typeof fields.elapsedMs).toBe('number');
    expect(JSON.stringify(fields)).not.toContain('bicycle');
  });

  it('writes one audit row per tool call behind the answer, under the service role, with the ids and never the prompt', async () => {
    const { handlers, insert, runAfterResponse, settled } = harness();
    const response = await handlers.POST(rpc('tools/call', { name: 'get_generation', arguments: { generation_id: GENERATION_ID } }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).toBeUndefined();
    // Scheduled behind the answer, not awaited in front of it.
    expect(runAfterResponse).toHaveBeenCalledTimes(1);
    await settled();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      user_id: USER_ID,
      client_id: 'client-claude',
      tool: 'get_generation',
      ok: true,
      code: null,
      generation_id: GENERATION_ID,
      post_id: null,
      cost_credits: null,
    });
    expect(JSON.stringify(insert.mock.calls)).not.toContain('bicycle');
  });

  it('records a refusal with its code, and a failed audit write never fails the tool\'s answer', async () => {
    const { handlers, insert, log, settled } = harness({
      auditInsert: async () => ({ error: { message: 'permission denied for table agent_tool_calls' } }),
      services: {
        listOwnerGenerationsForRoute: vi.fn(async () => ({
          generations: [],
          pagination: { limit: 1, hasMore: false, nextCursor: null },
        })) as unknown as McpToolServices['listOwnerGenerationsForRoute'],
      },
    });
    const response = await handlers.POST(rpc('tools/call', { name: 'get_generation', arguments: { generation_id: GENERATION_ID } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.code).toBe('NOT_FOUND');
    await settled();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ tool: 'get_generation', ok: false, code: 'NOT_FOUND', generation_id: GENERATION_ID }));
    // The failure is the operator's to see in the log, not the agent's.
    const warnings = log.mock.calls.filter(([, event]) => event === 'mcp_tool_call_record_failed');
    expect(warnings).toEqual([['warn', 'mcp_tool_call_record_failed', expect.objectContaining({
      tool: 'get_generation', clientId: 'client-claude', userId: USER_ID, error: { message: 'permission denied for table agent_tool_calls' },
    })]]);
  });

  it('answers a tool failure as a tool result with its code, logged as a warning', async () => {
    const { handlers, log } = harness({
      services: {
        listOwnerGenerationsForRoute: vi.fn(async () => ({
          generations: [],
          pagination: { limit: 1, hasMore: false, nextCursor: null },
        })) as unknown as McpToolServices['listOwnerGenerationsForRoute'],
      },
    });
    const response = await handlers.POST(rpc('tools/call', { name: 'get_generation', arguments: { generation_id: GENERATION_ID } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.code).toBe('NOT_FOUND');
    expect(body.result.content[0].text).toContain('NOT_FOUND');
    const [level, , fields] = log.mock.calls.find(([, event]) => event === 'mcp_tool_call') as [string, string, Record<string, unknown>];
    expect(level).toBe('warn');
    expect(fields).toMatchObject({ tool: 'get_generation', outcome: 'error', code: 'NOT_FOUND' });
  });

  it('answers an unknown tool as a JSON-RPC error, not a crash', async () => {
    const { handlers } = harness();
    const response = await handlers.POST(rpc('tools/call', { name: 'frobnicate_post', arguments: {} }));
    const body = await response.json();
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });
});

describe('the posting-only MCP route', () => {
  const POSTS = '/api/mcp/posts';

  it('challenges a missing or invalid token with its own protected-resource metadata', async () => {
    // Claude takes a document only when its resource is the URL the person connected.
    expect(bearerChallenge(SITE, 'x', 'posts')).toContain(`resource_metadata="${POSTS_METADATA_URL}"`);
    expect(bearerChallenge(SITE, 'x', 'full')).toContain(`resource_metadata="${METADATA_URL}"`);

    const missing = harness({ surface: 'posts' });
    const noToken = await missing.handlers.POST(rpc('tools/list', undefined, { token: null, path: POSTS }));
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('www-authenticate')).toContain(`resource_metadata="${POSTS_METADATA_URL}"`);
    expect(missing.admissionRpc).not.toHaveBeenCalled();

    const invalid = harness({ surface: 'posts', admission: null });
    const badToken = await invalid.handlers.POST(rpc('tools/list', undefined, { path: POSTS }));
    expect(badToken.status).toBe(401);
    expect(badToken.headers.get('www-authenticate')).toContain(`resource_metadata="${POSTS_METADATA_URL}"`);
  });

  it('keeps every refusal the full route has: the kill switch, a guest, a JWT, an ended grant', async () => {
    const off = harness({ surface: 'posts', env: { MCP_SERVER_DISABLED: '1' } });
    expect((await off.handlers.POST(rpc('tools/list', undefined, { path: POSTS }))).status).toBe(503);
    expect((await off.handlers.GET()).status).toBe(503);

    const guest = await harness({ surface: 'posts', admission: { ...POSTING_GRANT, is_anonymous: true } }).handlers.POST(rpc('tools/list', undefined, { path: POSTS }));
    expect(guest.status).toBe(403);
    expect((await guest.json()).code).toBe('REGISTRATION_REQUIRED');

    const jwt = await harness({ surface: 'posts' }).handlers.POST(rpc('tools/list', undefined, { path: POSTS, token: JWT }));
    expect(jwt.status).toBe(401);
    expect(jwt.headers.get('www-authenticate')).toContain(`resource_metadata="${POSTS_METADATA_URL}"`);

    const revoked = await harness({ surface: 'posts', admission: null }).handlers.POST(rpc('tools/list', undefined, { path: POSTS }));
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('www-authenticate')).toContain(`resource_metadata="${POSTS_METADATA_URL}"`);

    const { handlers } = harness({ surface: 'posts' });
    expect((await handlers.GET()).status).toBe(405);
    expect((await handlers.DELETE()).status).toBe(405);
  });

  it('lists the six posting tools and says so in its instructions, through the real transport', async () => {
    const { handlers } = harness({ surface: 'posts', admission: POSTING_GRANT });
    const initialized = await handlers.POST(rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    }, { path: POSTS }));
    expect(initialized.status).toBe(200);
    const initBody = await initialized.json();
    expect(initBody.result.serverInfo.name).toBe('magicbooklet');
    expect(initBody.result.instructions).toContain('It starts no run and spends no credits.');
    expect(initBody.result.instructions).not.toMatch(/create_media|quote_generation|enhance_prompt|list_models|get_model|get_generation/u);

    const listed = await handlers.POST(rpc('tools/list', undefined, { id: 2, path: POSTS }));
    expect(listed.status).toBe(200);
    const tools = (await listed.json()).result.tools as Array<{ name: string; title?: string; description?: string; annotations?: Record<string, unknown> }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(mcpToolsFor('posts').map((tool) => tool.name).sort());
    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).not.toMatch(/create_media|quote_generation|enhance_prompt|list_models|get_model|get_generation/u);
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });

  it('refuses a tool it does not have, and runs one it has under the same record', async () => {
    const { handlers, log, insert, settled, listOwnerGenerationsForRoute } = harness({ surface: 'posts', admission: POSTING_GRANT });
    // Every tool the full server has and this one has not is unknown here: refused by name, and nothing of it runs.
    const absentNames = MCP_TOOLS.map((tool) => tool.name).filter((name) => !mcpToolsFor('posts').some((tool) => tool.name === name));
    expect(absentNames).toHaveLength(6);
    for (const name of absentNames) {
      const absent = await handlers.POST(rpc('tools/call', { name, arguments: {} }, { path: POSTS }));
      const absentBody = await absent.json();
      const refusal = JSON.stringify(absentBody.error ?? absentBody.result);
      expect(absentBody.error ?? absentBody.result?.isError, name).toBeTruthy();
      expect(refusal, name).toMatch(/not found|unknown tool/iu);
      expect(refusal, name).toContain(name);
    }
    expect(insert).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([, event]) => event === 'mcp_tool_call')).toHaveLength(0);

    const response = await handlers.POST(rpc('tools/call', { name: 'list_creations', arguments: { limit: 5 } }, { id: 3, path: POSTS }));
    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).toBeFalsy();
    expect(listOwnerGenerationsForRoute).toHaveBeenCalledTimes(1);
    const [, , fields] = log.mock.calls.find(([, event]) => event === 'mcp_tool_call') as [string, string, Record<string, unknown>];
    expect(fields).toMatchObject({ clientId: MCP_POSTING_ONLY_CLIENT_IDS.claudeDirectory, surface: 'posts', tool: 'list_creations', outcome: 'ok' });
    await settled();
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('refuses a grant for the posting server at the full server, and takes a full grant at either', async () => {
    // The consent page showed this grant the posting-only list, so its token reaches no tool that list left out.
    const refused = harness({ admission: POSTING_GRANT });
    const response = await refused.handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'AGENT_SURFACE_NOT_ALLOWED' });
    expect(refused.createRequestServiceClient).not.toHaveBeenCalled();
    const call = await refused.handlers.POST(rpc('tools/call', { name: 'create_media', arguments: {} }));
    expect(call.status).toBe(403);
    expect(refused.insert).not.toHaveBeenCalled();

    // Any other client was granted the full list, of which the posting server is a part.
    const full = await harness({ surface: 'posts' }).handlers.POST(rpc('tools/list', undefined, { path: POSTS }));
    expect(full.status).toBe(200);
    expect(((await full.json()).result.tools as unknown[]).length).toBe(6);
    const fullOnFull = await harness().handlers.POST(rpc('tools/list'));
    expect(((await fullOnFull.json()).result.tools as unknown[]).length).toBe(MCP_TOOLS.length);
  });

  it('holds the same line for a request in the 2026-07-28 envelope', async () => {
    // The SDK serves that revision through its own handler, built per request from the admitted context.
    const posting = await harness({ surface: 'posts', admission: POSTING_GRANT }).handlers.POST(modernRpc('tools/list', {}, { path: POSTS }));
    expect(posting.status).toBe(200);
    const tools = (await posting.json()).result.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(mcpToolsFor('posts').map((tool) => tool.name).sort());

    const full = await harness().handlers.POST(modernRpc('tools/list'));
    expect(full.status).toBe(200);
    expect(((await full.json()).result.tools as unknown[]).length).toBe(MCP_TOOLS.length);

    // The posting grant is refused at the full server before either protocol leg is reached.
    const refused = await harness({ admission: POSTING_GRANT }).handlers.POST(modernRpc('tools/list'));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'AGENT_SURFACE_NOT_ALLOWED' });

    const absent = await harness({ surface: 'posts', admission: POSTING_GRANT }).handlers.POST(
      modernRpc('tools/call', { name: 'create_media', arguments: {} }, { path: POSTS }),
    );
    const absentBody = await absent.json();
    expect(absentBody.error ?? absentBody.result?.isError).toBeTruthy();
  });
});
