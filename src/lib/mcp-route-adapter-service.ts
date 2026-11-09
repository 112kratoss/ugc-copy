import 'server-only';

import {
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import { after, NextRequest, NextResponse } from 'next/server';

import { agentTokenClientId } from '@/lib/agent-token';
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
import {
  protectedResourceMetadataUrl,
  resolveMcpSiteOrigin,
} from '@/lib/oauth-protected-resource-metadata';
import { withProviderFetchRequestId } from '@/lib/provider-fetch';
import {
  evaluateUserFacingRouteIdentity,
  type ProxyIdentityDependencies,
} from '@/lib/route-identity-admission';
import { rebuildAdmittedRequest } from '@/lib/route-owned-identity-admission';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

/**
 * HTTP for the MCP server at /api/mcp: the kill switch, the route's own identity admission, and
 * the MCP transport, in that order.
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
 * the client's OAuth flow; a guest's token answers 403 REGISTRATION_REQUIRED as the proxy would;
 * a token without the agent claim answers 403 AGENT_TOKEN_REQUIRED (`agent-token.ts`), so a
 * copied app session cannot drive the server. The evaluator is the proxy's own, so revocation,
 * ban and lifecycle are checked afresh on every call, and the admitted request carries the same
 * trusted assertion the services see behind the proxy.
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
  identity?: ProxyIdentityDependencies;
  services?: Partial<McpToolServices>;
  createUserClient?: typeof createUserClient;
  createServiceClient?: typeof createServiceClient;
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
export function bearerChallenge(siteOrigin: string, description: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(siteOrigin)}", error="invalid_token", error_description="${description.replace(/"/g, "'")}"`;
}

function unauthorizedResponse(siteOrigin: string, description: string): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized', code: 'UNAUTHORIZED' },
    {
      status: 401,
      headers: { 'WWW-Authenticate': bearerChallenge(siteOrigin, description), 'Cache-Control': NO_STORE },
    },
  );
}

function forbiddenResponse(code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status: 403, headers: { 'Cache-Control': NO_STORE } });
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

async function serveMcp(admitted: NextRequest, context: McpToolContext, bearerToken: string): Promise<Response> {
  const authInfo: AuthInfo = {
    token: bearerToken,
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
  identity: { clientId: string; userId: string },
  record: McpToolCallRecord,
): void {
  // Never the arguments or the result: a prompt is the creator's own.
  log(record.outcome === 'ok' ? 'info' : record.outcome === 'error' ? 'warn' : 'error', 'mcp_tool_call', {
    clientId: identity.clientId,
    userId: identity.userId,
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
  const siteOrigin = siteOriginFor(request, dependencies);
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) {
    // Every connection starts with this call: the challenge it answers is how a client finds the
    // authorization server. Information, not a warning.
    logBackendInfo('mcp_request_refused', { code: 'UNAUTHORIZED', reason: 'no_token' });
    return unauthorizedResponse(siteOrigin, 'Sign in to Magicbooklet to use this server.');
  }

  const admission = await evaluateUserFacingRouteIdentity(request, dependencies.identity);
  if (admission.rejection) {
    const code = typeof admission.claims?.sub === 'string' ? 'identity' : 'token';
    logBackendWarning('mcp_request_refused', { status: admission.rejection.status, reason: code });
    return admission.rejection.status === 401
      ? unauthorizedResponse(siteOrigin, 'The access token is invalid or has expired. Sign in again.')
      : admission.rejection;
  }
  const clientId = agentTokenClientId(admission.claims);
  const userId = typeof admission.claims?.sub === 'string' ? admission.claims.sub : null;
  if (!userId) {
    logBackendWarning('mcp_request_refused', { code: 'UNAUTHORIZED', reason: 'no_claims' });
    return unauthorizedResponse(siteOrigin, 'The access token could not be verified. Sign in again.');
  }
  if (!clientId) {
    logBackendWarning('mcp_request_refused', { code: 'AGENT_TOKEN_REQUIRED', userId });
    return forbiddenResponse(
      'AGENT_TOKEN_REQUIRED',
      'Only a token issued to an agent through the Magicbooklet OAuth server can use the MCP server.',
    );
  }

  const admitted = await rebuildAdmittedRequest(request, admission);
  const makeUserClient = dependencies.createUserClient ?? createUserClient;
  const makeServiceClient = dependencies.createServiceClient ?? createServiceClient;
  const runAfterResponse = dependencies.runAfterResponse ?? runAfterResponseByDefault;
  let admin: ReturnType<typeof createServiceClient> | null = null;
  const createAdminSupabase = () => {
    admin ??= makeServiceClient();
    return admin;
  };
  const identity = { clientId, userId };
  const context: McpToolContext = {
    request: admitted,
    userId,
    clientId,
    siteOrigin,
    kieApiKey: dependencies.kieApiKey ?? env.KIE_AI_API_KEY,
    createUserSupabase: () => makeUserClient(admitted),
    createAdminSupabase,
    services: { ...defaultMcpToolServices(), ...dependencies.services },
    onToolCall: (record) => {
      logToolCall(log, identity, record);
      recordToolCall(log, createAdminSupabase, runAfterResponse, identity, record);
    },
    runAfterResponse,
  };
  const bearerToken = authorization.replace(/^Bearer\s+/iu, '');
  return withProviderFetchRequestId(getApiRequestId(request), () => serveMcp(admitted, context, bearerToken));
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
