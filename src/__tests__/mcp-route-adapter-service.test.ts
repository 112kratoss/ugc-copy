import type { SupabaseClient, User } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IDENTITY_ADMISSION_HEADER,
  registerIdentityAdmissionContext,
} from '@/lib/identity-admission-assertion';
import {
  bearerChallenge,
  createMcpRouteHandlers,
  isMcpServerDisabled,
  type McpRouteDependencies,
} from '@/lib/mcp-route-adapter-service';
import { MCP_TOOLS, type McpToolServices } from '@/lib/mcp-server-service';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';

const SITE = 'https://magicbooklet.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const GENERATION_ID = '22222222-2222-4222-8222-222222222222';
const METADATA_URL = `${SITE}/.well-known/oauth-protected-resource/api/mcp`;

const ACTIVE = { state: 'active', session_valid: true, banned: false, created_at: '2026-11-09T00:00:00Z' };
const AGENT_CLAIMS = { sub: USER_ID, aud: 'authenticated', role: 'authenticated', is_anonymous: false, client_id: 'client-claude' };
const SESSION_CLAIMS = { sub: USER_ID, aud: 'authenticated', role: 'authenticated', is_anonymous: false };
const GUEST_AGENT_CLAIMS = { ...AGENT_CLAIMS, is_anonymous: true };

function identity(claims: Record<string, unknown> | null = AGENT_CLAIMS, admission: unknown = ACTIVE) {
  return {
    auth: {
      getClaims: vi.fn(async () => (
        claims ? { data: { claims }, error: null } : { data: null, error: new Error('bad token') }
      )),
    },
    rpc: vi.fn(async () => ({ data: admission, error: null })),
  };
}

function rpc(method: string, params?: Record<string, unknown>, options: { token?: string | null; id?: number } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    [IDENTITY_ADMISSION_HEADER]: 'forged',
  };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? 'agent-token'}`;
  return new NextRequest(`${SITE}/api/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method, ...(params ? { params } : {}) }),
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

/** A route's user client: it must never need GoTrue, since the admitted request carries the assertion. */
function routeClient() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null as User | null }, error: new Error('not expected') as unknown })),
    },
  };
}

function harness(overrides: {
  claims?: Record<string, unknown> | null;
  admission?: unknown;
  env?: Record<string, string | undefined>;
  services?: Partial<McpToolServices>;
} = {}) {
  const identityClient = identity(overrides.claims === undefined ? AGENT_CLAIMS : overrides.claims, overrides.admission);
  const userClients: Array<{ request: Request; client: ReturnType<typeof routeClient> }> = [];
  const createUserClient = vi.fn((request: Request) => {
    const client = routeClient();
    registerIdentityAdmissionContext(client, request);
    userClients.push({ request, client });
    return client as unknown as SupabaseClient;
  });
  const admin = { from: vi.fn() } as unknown as SupabaseClient;
  const log = vi.fn();
  const listOwnerGenerationsForRoute = vi.fn(async () => summaryPayload());
  const dependencies: McpRouteDependencies = {
    identity: { createUserClient: () => identityClient },
    createUserClient,
    createServiceClient: () => admin,
    siteUrl: SITE,
    kieApiKey: 'kie-test-key',
    log,
    env: overrides.env ?? {},
    services: {
      listOwnerGenerationsForRoute: listOwnerGenerationsForRoute as unknown as McpToolServices['listOwnerGenerationsForRoute'],
      enforceBackendRateLimit: vi.fn(async () => undefined) as unknown as McpToolServices['enforceBackendRateLimit'],
      ...overrides.services,
    },
  };
  return { handlers: createMcpRouteHandlers(dependencies), identityClient, createUserClient, userClients, log, listOwnerGenerationsForRoute };
}

describe('MCP route adapter', () => {
  beforeEach(() => {
    vi.stubEnv('IDENTITY_ADMISSION_SECRET', 'test-secret-with-at-least-32-characters');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reads the kill switch as 1 or true and nothing else', () => {
    expect(isMcpServerDisabled({ MCP_SERVER_DISABLED: '1' })).toBe(true);
    expect(isMcpServerDisabled({ MCP_SERVER_DISABLED: 'true' })).toBe(true);
    expect(isMcpServerDisabled({ MCP_SERVER_DISABLED: '0' })).toBe(false);
    expect(isMcpServerDisabled({ MCP_SERVER_DISABLED: '' })).toBe(false);
    expect(isMcpServerDisabled({})).toBe(false);
  });

  it('answers 503 with Retry-After from the kill switch before reading any token, on every method', async () => {
    const { handlers, identityClient, createUserClient } = harness({ env: { MCP_SERVER_DISABLED: '1' } });
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
    expect(identityClient.auth.getClaims).not.toHaveBeenCalled();
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it('answers GET and DELETE 405: no SSE streams and no sessions', async () => {
    const { handlers } = harness();
    for (const response of [await handlers.GET(), await handlers.DELETE()]) {
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      await expect(response.json()).resolves.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    }
  });

  it('challenges a missing token with the protected-resource metadata, before contacting Auth', async () => {
    const { handlers, identityClient } = harness();
    const response = await handlers.POST(rpc('tools/list', undefined, { token: null }));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}", error="invalid_token", error_description="Sign in to Magicbooklet to use this server."`,
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(identityClient.auth.getClaims).not.toHaveBeenCalled();
  });

  it('challenges an invalid token the same way, after the signature check and before any lookup', async () => {
    const { handlers, identityClient, createUserClient } = harness({ claims: null });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(`Bearer resource_metadata="${METADATA_URL}", error="invalid_token"`);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(identityClient.rpc).not.toHaveBeenCalled();
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it("builds the challenge's metadata URL from the site origin", () => {
    expect(bearerChallenge('https://magicbooklet.com', 'Say "hi"')).toBe(
      'Bearer resource_metadata="https://magicbooklet.com/.well-known/oauth-protected-resource/api/mcp", error="invalid_token", error_description="Say \'hi\'"',
    );
  });

  it('refuses a guest 403 REGISTRATION_REQUIRED, as the proxy would', async () => {
    const { handlers, createUserClient } = harness({ claims: GUEST_AGENT_CLAIMS });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it("refuses an app session's token, which carries no client_id, with 403 AGENT_TOKEN_REQUIRED", async () => {
    const { handlers, identityClient, createUserClient } = harness({ claims: SESSION_CLAIMS });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({ code: 'AGENT_TOKEN_REQUIRED' });
    // The lifecycle was checked (a live identity), and nothing of the server ran.
    expect(identityClient.rpc).toHaveBeenCalledTimes(1);
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it('signs a revoked grant out: a still-valid signature with no session answers 401 with the challenge', async () => {
    // Revoking a grant deletes the client's sessions. GoTrue keeps accepting the access token's
    // signature until it expires, so a signature-only check would keep serving the agent; the
    // lifecycle round trip answers session_valid false, and that is what signs the agent out
    // (docs/research/mcp-oauth-spike-2026-11-09.md, check 3).
    const { handlers, identityClient, createUserClient } = harness({ admission: { ...ACTIVE, session_valid: false } });
    const response = await handlers.POST(rpc('tools/list'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}", error="invalid_token", error_description="The access token is invalid or has expired. Sign in again."`,
    );
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    expect(identityClient.auth.getClaims).toHaveBeenCalledTimes(1);
    expect(identityClient.rpc).toHaveBeenCalledTimes(1);
    expect(createUserClient).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...ACTIVE, state: 'merged' }, 409, 'SESSION_MERGED'],
    [{ ...ACTIVE, state: 'deleting' }, 409, 'ACCOUNT_DELETING'],
    [{ ...ACTIVE, session_valid: false }, 401, 'UNAUTHORIZED'],
    [{ ...ACTIVE, banned: true }, 401, 'UNAUTHORIZED'],
  ])('passes the evaluator\'s other refusals through (%j)', async (admission, status, code) => {
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

  it('hands the services an admitted request carrying the fresh assertion, and logs one line per tool call without the prompt', async () => {
    const { handlers, createUserClient, userClients, log, listOwnerGenerationsForRoute } = harness();
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

    // The request the services see is the admitted one: the caller's forged assertion is gone,
    // the route's signed one is there, and the services read the identity from it without a
    // GoTrue round trip, as they do behind the proxy.
    expect(createUserClient).toHaveBeenCalledTimes(1);
    const [{ request: admitted, client }] = userClients;
    expect(admitted.headers.get(IDENTITY_ADMISSION_HEADER)).not.toBe('forged');
    expect(admitted.headers.get('authorization')).toBe('Bearer agent-token');
    expect((await getVerifiedAuthUserResult(client)).data.user?.id).toBe(USER_ID);
    expect(client.auth.getUser).not.toHaveBeenCalled();
    expect(listOwnerGenerationsForRoute).toHaveBeenCalledTimes(1);
    const [{ userId, searchParams }] = listOwnerGenerationsForRoute.mock.calls[0] as unknown as [{ userId: string; searchParams: URLSearchParams }];
    expect(userId).toBe(USER_ID);
    expect(searchParams.get('detail')).toBe('summary');
    expect(searchParams.get('limit')).toBe('5');

    const toolCalls = log.mock.calls.filter(([, event]) => event === 'mcp_tool_call');
    expect(toolCalls).toHaveLength(1);
    const [level, , fields] = toolCalls[0] as [string, string, Record<string, unknown>];
    expect(level).toBe('info');
    expect(fields).toMatchObject({ clientId: 'client-claude', userId: USER_ID, tool: 'list_creations', outcome: 'ok', code: null });
    expect(typeof fields.elapsedMs).toBe('number');
    expect(JSON.stringify(fields)).not.toContain('bicycle');
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
    const response = await handlers.POST(rpc('tools/call', { name: 'publish_post', arguments: {} }));
    const body = await response.json();
    expect(body.error ?? body.result?.isError).toBeTruthy();
  });
});
