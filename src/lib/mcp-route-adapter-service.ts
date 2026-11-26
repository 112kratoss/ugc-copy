import 'server-only';

import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { after, NextRequest, NextResponse } from 'next/server';

import { admitAgentAccessToken } from '@/lib/agent-oauth-admission';
import { isAppAgentAccessToken } from '@/lib/agent-token';
import { buildAgentToolCallRow, recordAgentToolCall } from '@/lib/agent-tool-calls';
import { getApiRequestId } from '@/lib/api-cache';
import { logBackendEvent, logBackendInfo, logBackendWarning } from '@/lib/backend-logger';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import {
  createMcpServer,
  defaultMcpToolServices,
  type McpToolCallRecord,
  type McpToolContext,
  type McpToolServices,
} from '@/lib/mcp-server-service';
import type { McpSurface } from '@/lib/mcp-surfaces';
import {
  protectedResourceMetadataUrl,
  resolveMcpSiteOrigin,
} from '@/lib/oauth-protected-resource-metadata';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import {
  IDENTITY_ADMISSION_HEADER,
  IDENTITY_PROXY_TIMING_HEADER,
  registerAdmittedIdentity,
} from '@/lib/identity-admission-assertion';
import { createRequestServiceClient, createServiceClient } from '@/lib/server-helpers';

/**
 * HTTP for the MCP server at /api/mcp and its posting-only form at /api/mcp/posts
 * (`mcp-surfaces.ts`): the kill switch, the route's own identity admission, and the MCP
 * transport, in that order. The two paths share everything here but the tools the server
 * registers, the resource their 401 names, and one refusal: a token issued to a posting-only
 * OAuth client answers 403 AGENT_SURFACE_NOT_ALLOWED at /api/mcp, so the client the consent page
 * showed the posting-only list cannot reach a tool that list left out.
 *
 * Transport. Stateless Streamable HTTP with a JSON body per answer: no sessions, no SSE streams,
 * no Redis, so a Vercel function serves each POST on its own. The MCP server SDK v2's
 * web-standard transport does this directly (`WebStandardStreamableHTTPServerTransport` with
 * `sessionIdGenerator: undefined` and `enableJsonResponse: true`); Vercel's `mcp-handler` 2.3
 * was not used because it offers no way to switch on JSON answers for the 2025-era protocol every
 * current client speaks (it passes only `legacy`, `onerror` and `maxSubscriptions` to the SDK,
 * whose stateless legacy leg then streams each answer over SSE). A request in the 2026-07-28
 * envelope goes to the SDK's own handler for that revision, strict about the era
 * (`legacy: 'reject'`) because the legacy leg is served here; its default `auto` response mode
 * answers JSON unless a handler emits a notification before its result, and no tool here does.
 * GET and DELETE (2025 session operations) answer 405.
 *
 * Admission. The proxy leaves this route to itself (`route-owned-identity-admission.ts`) so the
 * refusals can carry what MCP clients need: a missing or invalid token answers 401 with a
 * `WWW-Authenticate` challenge naming the protected-resource metadata (RFC 9728), which starts
 * the client's OAuth flow at the app's own authorization server. The only token taken is that
 * server's opaque access token (`mbat_…`): one database round trip answers the token, its grant
 * and the account's lifecycle, in the proxy's order (`agent-oauth-admission.ts`). The tools then
 * run on a service-role client made for the request and told who the admitted account is; the
 * agent's token is taken off the request the services see, so it goes nowhere. A JWT of any
 * kind, an agent's or a first-party session's, is answered 401 before anything reads it, so a
 * copied app session cannot drive the server.
 *
 * The record. Every tool call writes one log line (`mcp_tool_call`, below) and one row of
 * `public.agent_tool_calls` (`agent-tool-calls.ts`), the audit table moderation reads to list
 * what agents published. The row is written behind the answer (Next's `after`), under the service
 * role, and a write that fails is logged and nothing more: the agent's answer never waits on the
 * record and never fails by it.
 */

export const MCP_DISABLED_RETRY_AFTER_SECONDS = 300;

type Environment = Record<string, string | undefined>;

export type McpRouteDependencies = {
  /** Which server the route is: the full one unless said (`mcp-surfaces.ts`). */
  surface?: McpSurface;
  services?: Partial<McpToolServices>;
  createServiceClient?: typeof createServiceClient;
  /** The per-request service client the tools run on; its own, never the shared one. */
  createRequestServiceClient?: typeof createRequestServiceClient;
  kieApiKey?: string;
  siteUrl?: string;
  log?: typeof logBackendEvent;
  /** Where the audit row and a publish's alert go once the answer is out; Next's `after` by default. */
  runAfterResponse?: RunAfterResponse;
  env?: Environment;
};

/**
 * Next's `after`, which takes a task only inside a request. Outside one (a test, a script) it
 * throws, and the task runs at once instead: the record is still written, in front of nothing.
 */
function runAfterResponseByDefault(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

export function isMcpServerDisabled(env: Environment = process.env): boolean {
  const value = env.MCP_SERVER_DISABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

const NO_STORE = 'private, no-store';

function disabledResponse(): NextResponse {
  return NextResponse.json(
    { error: 'The Magicbooklet MCP server is switched off for maintenance. Try again later.', code: 'MCP_SERVER_DISABLED' },
    { status: 503, headers: { 'Retry-After': String(MCP_DISABLED_RETRY_AFTER_SECONDS), 'Cache-Control': NO_STORE } },
  );
}

function methodNotAllowedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'The MCP server takes POST only: it keeps no sessions and opens no streams.', code: 'METHOD_NOT_ALLOWED' },
    { status: 405, headers: { Allow: 'POST', 'Cache-Control': NO_STORE } },
  );
}

/** The challenge that sends an MCP client to the protected-resource metadata and on to sign in. */
export function bearerChallenge(siteOrigin: string, description: string, surface: McpSurface = 'full'): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(siteOrigin, surface)}", error="invalid_token", error_description="${description.replace(/"/g, "'")}"`;
}

function unauthorizedResponse(siteOrigin: string, description: string, surface: McpSurface): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized', code: 'UNAUTHORIZED' },
    {
      status: 401,
      headers: { 'WWW-Authenticate': bearerChallenge(siteOrigin, description, surface), 'Cache-Control': NO_STORE },
    },
  );
}

function siteOriginFor(request: NextRequest, dependencies: McpRouteDependencies): string {
  return resolveMcpSiteOrigin(dependencies.siteUrl) ?? new URL(request.url).origin;
}

/**
 * The SDK's handler for the 2026-07-28 revision, built once: its factory binds the tools to the
 * admitted request's context, which rides in `authInfo.extra` (the SDK passes `authInfo` through
 * untouched). `maxSubscriptions: 0` refuses `subscriptions/listen` without opening a stream.
 */
const modernHandler = createMcpHandler(
  (ctx) => {
    const context = ctx.authInfo?.extra?.mcpContext as McpToolContext | undefined;
    if (!context) throw new Error('MCP request reached the server without an admitted context.');
    return createMcpServer(context);
  },
  { legacy: 'reject', maxSubscriptions: 0 },
);

/**
 * The request the services see: the caller's, without its Authorization header (the opaque token
 * means nothing downstream and must not travel) and without any assertion or timing header the
 * caller sent. The body is read once, as `rebuildAdmittedRequest` does
 * (`route-owned-identity-admission.ts`) and for the same reason.
 */
async function rebuildRequestWithoutCredentials(request: NextRequest): Promise<NextRequest> {
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.delete(IDENTITY_ADMISSION_HEADER);
  headers.delete(IDENTITY_PROXY_TIMING_HEADER);
  return new NextRequest(request.url, {
    method: request.method,
    headers,
    signal: request.signal,
    body: await request.text(),
  });
}

/** What the SDK is given as the token: a marker, never the secret. */
const APP_TOKEN_MARKER = 'app-agent-token';

function bearerTokenOf(authorization: string): string | null {
  return authorization.match(/^Bearer\s+(\S+)$/iu)?.[1] ?? null;
}

async function serveMcp(admitted: NextRequest, context: McpToolContext): Promise<Response> {
  const authInfo: AuthInfo = {
    token: APP_TOKEN_MARKER,
    clientId: context.clientId,
    scopes: [],
    extra: { userId: context.userId, mcpContext: context },
  };
  if (!(await isLegacyRequest(admitted))) {
    return modernHandler.fetch(admitted, { authInfo });
  }
  const server = createMcpServer(context);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    // JSON mode: the body is complete when this resolves, so the pair can close at once.
    return await transport.handleRequest(admitted, { authInfo });
  } finally {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  }
}

function logToolCall(
  log: typeof logBackendEvent,
  identity: { clientId: string; userId: string; surface: McpSurface },
  record: McpToolCallRecord,
): void {
  // Never the arguments or the result: a prompt is the creator's own.
  log(record.outcome === 'ok' ? 'info' : record.outcome === 'error' ? 'warn' : 'error', 'mcp_tool_call', {
    clientId: identity.clientId,
    userId: identity.userId,
    surface: identity.surface,
    tool: record.tool,
    outcome: record.outcome,
    code: record.code,
    costCredits: record.costCredits,
    generationId: record.generationId,
    postId: record.postId,
    elapsedMs: Math.round(record.elapsedMs),
    ...(record.error !== undefined ? { error: record.error } : {}),
  });
}

/**
 * The audit row, written behind the answer. `cost_credits` is set only where the answer charged
 * the creator (the record carries null for a quote, a failure and a replay). A thrown tool is
 * recorded as a failure with its INTERNAL_ERROR code.
 */
function recordToolCall(
  log: typeof logBackendEvent,
  admin: () => ReturnType<typeof createServiceClient>,
  runAfterResponse: RunAfterResponse,
  identity: { clientId: string; userId: string },
  record: McpToolCallRecord,
): void {
  const row = buildAgentToolCallRow({
    userId: identity.userId,
    clientId: identity.clientId,
    tool: record.tool,
    ok: record.outcome === 'ok',
    code: record.code,
    generationId: record.generationId,
    postId: record.postId,
    costCredits: record.costCredits,
  });
  const failed = (error: unknown) => {
    log('warn', 'mcp_tool_call_record_failed', { tool: record.tool, clientId: identity.clientId, userId: identity.userId, error });
  };
  const write = async () => {
    const written = await recordAgentToolCall(admin(), row);
    if (!written.ok) failed(written.error);
  };
  try {
    runAfterResponse(write);
  } catch (error) {
    failed(error);
  }
}

async function handleMcpPost(request: NextRequest, dependencies: McpRouteDependencies): Promise<Response> {
  const env = dependencies.env ?? process.env;
  if (isMcpServerDisabled(env)) return disabledResponse();

  const log = dependencies.log ?? logBackendEvent;
  const surface = dependencies.surface ?? 'full';
  const siteOrigin = siteOriginFor(request, dependencies);
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) {
    // Every connection starts with this call: the challenge it answers is how a client finds the
    // authorization server. Information, not a warning.
    logBackendInfo('mcp_request_refused', { code: 'UNAUTHORIZED', reason: 'no_token', surface });
    return unauthorizedResponse(siteOrigin, 'Sign in to Magicbooklet to use this server.', surface);
  }

  const bearer = bearerTokenOf(authorization);
  // Only the app's own opaque token is read at all: a JWT of any kind, an agent's or a
  // first-party session's, is refused here before anything looks at it.
  if (!isAppAgentAccessToken(bearer)) {
    logBackendWarning('mcp_request_refused', { status: 401, reason: 'token_kind', surface });
    return unauthorizedResponse(siteOrigin, 'The access token is invalid or has expired. Sign in again.', surface);
  }

  const makeServiceClient = dependencies.createServiceClient ?? createServiceClient;
  const runAfterResponse = dependencies.runAfterResponse ?? runAfterResponseByDefault;
  let admin: ReturnType<typeof createServiceClient> | null = null;
  const createAdminSupabase = () => {
    admin ??= makeServiceClient();
    return admin;
  };

  const admission = await admitAgentAccessToken(bearer, { admin: createAdminSupabase(), surface });
  if (!admission.ok) {
    logBackendWarning('mcp_request_refused', { status: admission.status, code: admission.code, surface });
    return admission.status === 401
      ? unauthorizedResponse(siteOrigin, 'The access token is invalid or has expired. Sign in again.', surface)
      : NextResponse.json(
          { error: admission.error, code: admission.code },
          { status: admission.status, headers: { 'Cache-Control': NO_STORE } },
        );
  }
  const { userId, clientId } = admission;
  const admitted = await rebuildRequestWithoutCredentials(request);
  const makeRequestClient = dependencies.createRequestServiceClient ?? createRequestServiceClient;
  let requestClient: ReturnType<typeof createRequestServiceClient> | null = null;
  const createUserSupabase: McpToolContext['createUserSupabase'] = () => {
    if (!requestClient) {
      requestClient = makeRequestClient();
      // The services ask this client who the caller is (`getVerifiedAuthUserResult`).
      registerAdmittedIdentity(requestClient, admission.user);
    }
    return requestClient;
  };

  const identity = { clientId, userId, surface };
  const context: McpToolContext = {
    request: admitted,
    userId,
    clientId,
    surface,
    siteOrigin,
    kieApiKey: dependencies.kieApiKey ?? env.KIE_AI_API_KEY,
    createUserSupabase,
    createAdminSupabase,
    services: { ...defaultMcpToolServices(), ...dependencies.services },
    onToolCall: (record) => {
      logToolCall(log, identity, record);
      recordToolCall(log, createAdminSupabase, runAfterResponse, identity, record);
    },
    runAfterResponse,
  };
  return withProviderFetchRequestId(getApiRequestId(request), () => serveMcp(admitted, context));
}

function handleMcpOther(dependencies: McpRouteDependencies): Response {
  if (isMcpServerDisabled(dependencies.env ?? process.env)) return disabledResponse();
  return methodNotAllowedResponse();
}

export function createMcpRouteHandlers(dependencies: McpRouteDependencies = {}) {
  return {
    GET: async () => handleMcpOther(dependencies),
    DELETE: async () => handleMcpOther(dependencies),
    POST: (request: NextRequest) => handleMcpPost(request, dependencies),
  };
}
