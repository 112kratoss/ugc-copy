import 'server-only';

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { isGuestUser } from '@/lib/account-identity';
import { isAppAuthorizationServerEnabled } from '@/lib/agent-oauth-mode';
import { AgentOAuthError, isClientId } from '@/lib/agent-oauth-request';
import {
  decideAgentConsent,
  disconnectAgentClient,
  disconnectEveryAgentClient,
  exchangeAgentToken,
  listAgentGrants,
  revokeAgentToken,
  startAgentAuthorization,
} from '@/lib/agent-oauth-server-service';
import { isAgentToken } from '@/lib/agent-token';
import { BackendRateLimitError, enforceBackendRateLimit } from '@/lib/backend-rate-limit';
import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import { getClientNetworkKey } from '@/lib/client-network-key';
import { resolveMcpSiteOrigin } from '@/lib/oauth-protected-resource-metadata';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

/**
 * HTTP for the app's own authorization server (`docs/plans/agent-token-broker-plan-2026-11-26.md`):
 *
 * - `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke`: what an OAuth client calls.
 *   They sit outside `/api`, so the proxy's bearer admission does not run for them and they take
 *   no session: a client is who its registration says, and an account answers on the consent page.
 * - `POST /api/oauth/consent`, `GET` and `DELETE /api/oauth/grants`: what this app's own pages
 *   call with the web session's token, registered accounts only (`route-identity-policy.ts`).
 *
 * All of it answers 404 until `MCP_AUTHORIZATION_SERVER` switches the server on
 * (`agent-oauth-mode.ts`), except the grants list, which is then empty. Every answer is
 * `no-store`. Nothing here logs a parameter's value: a refusal is logged by its error code.
 */

type Environment = Record<string, string | undefined>;

export type AgentOAuthRouteDependencies = {
  createServiceClient?: () => SupabaseClient;
  createUserClient?: (request: Request) => SupabaseClient;
  enforceBackendRateLimit?: typeof enforceBackendRateLimit;
  siteUrl?: string;
  env?: Environment;
  now?: () => Date;
};

/** Per network address: an authorize request is a person opening a link. */
export const AGENT_OAUTH_AUTHORIZE_RATE_LIMIT = { scope: 'agent-oauth:authorize', limit: 30, windowSeconds: 60 } as const;
/** Per network address: a client exchanging a code or refreshing. Hosted clients share addresses. */
export const AGENT_OAUTH_TOKEN_RATE_LIMIT = { scope: 'agent-oauth:token', limit: 60, windowSeconds: 60 } as const;
export const AGENT_OAUTH_REVOKE_RATE_LIMIT = { scope: 'agent-oauth:revoke', limit: 30, windowSeconds: 60 } as const;
/** Per account: an answer on the consent page, or a disconnect. */
export const AGENT_OAUTH_CONSENT_RATE_LIMIT = { scope: 'agent-oauth:consent', limit: 20, windowSeconds: 60 } as const;

/** A form body is a handful of short parameters; anything larger is not a token request. */
const MAX_FORM_BYTES = 16 * 1024;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
} as const;

/**
 * The token and revocation endpoints are called cross-origin by browser-based MCP clients, with
 * no cookie and no ambient credential: the request carries everything that authorizes it.
 */
function tokenCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
}

function resolve(dependencies: AgentOAuthRouteDependencies) {
  return {
    admin: dependencies.createServiceClient ?? createServiceClient,
    userClient: dependencies.createUserClient ?? createUserClient,
    rateLimit: dependencies.enforceBackendRateLimit ?? enforceBackendRateLimit,
    env: dependencies.env ?? process.env,
    now: dependencies.now,
    siteUrl: dependencies.siteUrl,
  };
}

type Resolved = ReturnType<typeof resolve>;

function siteOriginFor(request: Request, resolved: Resolved): string {
  return resolveMcpSiteOrigin(resolved.siteUrl) ?? new URL(request.url).origin;
}

function notFound(headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404, headers: { ...NO_STORE_HEADERS, ...headers } });
}

function oauthErrorResponse(error: AgentOAuthError, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(
    { error: error.error, error_description: error.description },
    { status: error.status, headers: { ...NO_STORE_HEADERS, ...headers } },
  );
}

function rateLimitedResponse(error: BackendRateLimitError, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(
    { error: 'temporarily_unavailable', error_description: 'Too many requests. Try again shortly.' },
    { status: 429, headers: { ...NO_STORE_HEADERS, ...headers, 'Retry-After': String(error.retryAfterSeconds) } },
  );
}

function unavailableResponse(headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(
    { error: 'temporarily_unavailable', error_description: 'The authorization server is temporarily unavailable.' },
    { status: 503, headers: { ...NO_STORE_HEADERS, ...headers, 'Retry-After': '5' } },
  );
}

/** A short plain page for a person whose request cannot be sent back to any client. */
function plainPage(status: number, message: string): NextResponse {
  return new NextResponse(`${message}\n`, {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ---------------------------------------------------------------------------------------------
// GET /oauth/authorize

async function handleAuthorize(request: Request, dependencies: AgentOAuthRouteDependencies): Promise<NextResponse> {
  const resolved = resolve(dependencies);
  if (!isAppAuthorizationServerEnabled(resolved.env)) return notFound();
  const admin = resolved.admin();
  try {
    await resolved.rateLimit(admin, { ...AGENT_OAUTH_AUTHORIZE_RATE_LIMIT, key: getClientNetworkKey(request.headers) });
    const started = await startAgentAuthorization(new URL(request.url).searchParams, {
      admin,
      siteOrigin: siteOriginFor(request, resolved),
      now: resolved.now,
    });
    if (started.kind === 'page') {
      logBackendWarning('agent_oauth_authorize_refused', { kind: 'page' });
      return plainPage(400, `${started.description} Go back to the app and start the connection again.`);
    }
    if (started.kind === 'redirect') logBackendWarning('agent_oauth_authorize_refused', { kind: 'redirect' });
    // The consent page is on the host the person is on, where their session is.
    const location = started.kind === 'consent' ? new URL(started.location, request.url).toString() : started.location;
    return new NextResponse(null, { status: 302, headers: { ...NO_STORE_HEADERS, Location: location } });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return plainPage(429, 'Too many connection requests from this network. Wait a minute and try again.');
    }
    logBackendError('agent_oauth_authorize_failed', { error });
    return plainPage(503, 'Magicbooklet could not start this connection. Try again in a moment.');
  }
}

export function createAgentOAuthAuthorizeHandlers(dependencies: AgentOAuthRouteDependencies = {}) {
  return { GET: (request: Request) => handleAuthorize(request, dependencies) };
}

// ---------------------------------------------------------------------------------------------
// POST /oauth/token and POST /oauth/revoke

async function readForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new AgentOAuthError('invalid_request', 'The request body must be application/x-www-form-urlencoded.');
  }
  const body = await request.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_FORM_BYTES) {
    throw new AgentOAuthError('invalid_request', 'The request body is too large.');
  }
  return new URLSearchParams(body);
}

async function handleClientCall(
  request: Request,
  dependencies: AgentOAuthRouteDependencies,
  limit: { scope: string; limit: number; windowSeconds: number },
  event: string,
  call: (input: { form: URLSearchParams; authorizationHeader: string | null }, admin: SupabaseClient, resolved: Resolved) => Promise<NextResponse>,
): Promise<NextResponse> {
  const cors = tokenCorsHeaders();
  const resolved = resolve(dependencies);
  if (!isAppAuthorizationServerEnabled(resolved.env)) return notFound(cors);
  const authorizationHeader = request.headers.get('authorization');
  try {
    const admin = resolved.admin();
    await resolved.rateLimit(admin, { ...limit, key: getClientNetworkKey(request.headers) });
    return await call({ form: await readForm(request), authorizationHeader }, admin, resolved);
  } catch (error) {
    if (error instanceof BackendRateLimitError) return rateLimitedResponse(error, cors);
    if (error instanceof AgentOAuthError) {
      // The code alone: a description can echo what was sent.
      logBackendWarning(event, { error: error.error, status: error.status });
      const challenge: Record<string, string> = error.status === 401 && /^Basic\s/iu.test(authorizationHeader ?? '')
        ? { 'WWW-Authenticate': 'Basic realm="Magicbooklet OAuth", charset="UTF-8"' }
        : {};
      return oauthErrorResponse(error, { ...cors, ...challenge });
    }
    logBackendError(`${event}_failed`, { error });
    return unavailableResponse(cors);
  }
}

export function createAgentOAuthTokenHandlers(dependencies: AgentOAuthRouteDependencies = {}) {
  return {
    POST: (request: Request) => handleClientCall(
      request,
      dependencies,
      AGENT_OAUTH_TOKEN_RATE_LIMIT,
      'agent_oauth_token_refused',
      async (input, admin, resolved) => NextResponse.json(
        await exchangeAgentToken(input, { admin, siteOrigin: siteOriginFor(request, resolved), now: resolved.now }),
        { status: 200, headers: { ...NO_STORE_HEADERS, ...tokenCorsHeaders() } },
      ),
    ),
    OPTIONS: () => new NextResponse(null, { status: 204, headers: tokenCorsHeaders() }),
  };
}

export function createAgentOAuthRevokeHandlers(dependencies: AgentOAuthRouteDependencies = {}) {
  return {
    POST: (request: Request) => handleClientCall(
      request,
      dependencies,
      AGENT_OAUTH_REVOKE_RATE_LIMIT,
      'agent_oauth_revoke_refused',
      async (input, admin) => {
        await revokeAgentToken(input, { admin });
        // RFC 7009: 200 whether or not the token was one of the client's.
        return new NextResponse(null, { status: 200, headers: { ...NO_STORE_HEADERS, ...tokenCorsHeaders() } });
      },
    ),
    OPTIONS: () => new NextResponse(null, { status: 204, headers: tokenCorsHeaders() }),
  };
}

// ---------------------------------------------------------------------------------------------
// The app's own pages: POST /api/oauth/consent, GET and DELETE /api/oauth/grants

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function bearerClaims(request: Request): Record<string, unknown> | null {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/iu)?.[1];
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The registered account behind the web session's token, or the refusal. The proxy has already
 * admitted the request (`registered`, and it refuses an agent's token on every route but the MCP
 * ones); these routes decide what agents may do, so the agent-token refusal is repeated here on
 * the token itself, whose signature the lookup below has verified, in case the route is ever
 * reached without the proxy.
 */
async function requireWebAccount(request: Request, resolved: Resolved): Promise<User | NextResponse> {
  const { data: { user }, error } = await getVerifiedAuthUserResult(resolved.userClient(request));
  if (error || !user) return json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  if (isAgentToken(bearerClaims(request))) {
    return json({ error: 'An agent token can only be used with the MCP server.', code: 'AGENT_TOKEN_NOT_ALLOWED' }, 403);
  }
  if (isGuestUser(user)) return json({ error: 'Create an account to use this feature.', code: 'REGISTRATION_REQUIRED' }, 403);
  return user;
}

/**
 * A state-changing call from this app's own page: its `Origin` is this site's and, where the
 * browser says, the request is same-origin. The session token in the header already keeps another
 * site from making the call (it cannot read the token); this refuses one that somehow could.
 */
function isSameOriginCall(request: Request, resolved: Resolved): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const allowed = new Set([new URL(request.url).origin]);
  const site = resolveMcpSiteOrigin(resolved.siteUrl);
  if (site) allowed.add(site);
  if (!allowed.has(origin)) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === null || fetchSite === 'same-origin';
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return null;
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const CONSENT_UNAVAILABLE = () => json({
  error: 'This connection request has expired or was already answered.',
  code: 'CONSENT_UNAVAILABLE',
}, 409);

async function handleConsent(request: Request, dependencies: AgentOAuthRouteDependencies): Promise<NextResponse> {
  const resolved = resolve(dependencies);
  if (!isAppAuthorizationServerEnabled(resolved.env)) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  if (!isSameOriginCall(request, resolved)) return json({ error: 'Forbidden', code: 'CROSS_ORIGIN_REFUSED' }, 403);
  const user = await requireWebAccount(request, resolved);
  if (user instanceof NextResponse) return user;
  const body = await readJsonBody(request);
  const decision = body?.decision;
  if (
    !body
    || typeof body.authorizationId !== 'string'
    || typeof body.consentToken !== 'string'
    || (decision !== 'approve' && decision !== 'deny')
  ) {
    return json({ error: 'The answer is malformed.', code: 'INVALID_REQUEST' }, 400);
  }
  try {
    const admin = resolved.admin();
    await resolved.rateLimit(admin, { ...AGENT_OAUTH_CONSENT_RATE_LIMIT, key: user.id });
    const decided = await decideAgentConsent(
      { authorizationId: body.authorizationId, userId: user.id, consentToken: body.consentToken, decision },
      { admin, now: resolved.now },
    );
    return decided ? json({ redirect_url: decided.redirectUrl }) : CONSENT_UNAVAILABLE();
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return json({ error: error.message, code: 'RATE_LIMITED', retryAfterSeconds: error.retryAfterSeconds }, 429);
    }
    logBackendError('agent_oauth_consent_failed', { userId: user.id, error });
    return json({ error: 'Your answer could not be saved. Try again.', code: 'CONSENT_FAILED' }, 503);
  }
}

export function createAgentOAuthConsentHandlers(dependencies: AgentOAuthRouteDependencies = {}) {
  return { POST: (request: Request) => handleConsent(request, dependencies) };
}

async function handleGrantsList(request: Request, dependencies: AgentOAuthRouteDependencies): Promise<NextResponse> {
  const resolved = resolve(dependencies);
  const user = await requireWebAccount(request, resolved);
  if (user instanceof NextResponse) return user;
  // With the server off there is nothing it could have granted.
  if (!isAppAuthorizationServerEnabled(resolved.env)) return json({ grants: [] });
  try {
    const grants = await listAgentGrants(resolved.admin(), user.id);
    return json({
      grants: grants.map((grant) => ({
        client: { id: grant.clientId, name: grant.name, uri: grant.uri },
        granted_at: grant.grantedAt,
        surface: grant.surface,
      })),
    });
  } catch (error) {
    logBackendError('agent_oauth_grants_list_failed', { userId: user.id, error });
    return json({ error: 'The connected apps could not be read.', code: 'GRANTS_UNAVAILABLE' }, 503);
  }
}

async function handleGrantsRevoke(request: Request, dependencies: AgentOAuthRouteDependencies): Promise<NextResponse> {
  const resolved = resolve(dependencies);
  if (!isSameOriginCall(request, resolved)) return json({ error: 'Forbidden', code: 'CROSS_ORIGIN_REFUSED' }, 403);
  const user = await requireWebAccount(request, resolved);
  if (user instanceof NextResponse) return user;
  const body = await readJsonBody(request);
  // One app by its client id, or `all: true` for every app ("Sign out everywhere"): never both.
  const clientId = body?.clientId;
  const all = body?.all === true;
  if (all ? clientId !== undefined : !isClientId(clientId)) {
    return json({ error: 'clientId is required, or all: true alone.', code: 'INVALID_REQUEST' }, 400);
  }
  if (!isAppAuthorizationServerEnabled(resolved.env)) return json({ revoked: 0 });
  try {
    const admin = resolved.admin();
    await resolved.rateLimit(admin, { ...AGENT_OAUTH_CONSENT_RATE_LIMIT, key: user.id });
    const revoked = all
      ? await disconnectEveryAgentClient(admin, { userId: user.id })
      : await disconnectAgentClient(admin, { userId: user.id, clientId: clientId as string });
    return json({ revoked });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return json({ error: error.message, code: 'RATE_LIMITED', retryAfterSeconds: error.retryAfterSeconds }, 429);
    }
    logBackendError('agent_oauth_grants_revoke_failed', { userId: user.id, error });
    return json({ error: 'The app could not be disconnected. Try again.', code: 'GRANTS_UNAVAILABLE' }, 503);
  }
}

export function createAgentOAuthGrantsHandlers(dependencies: AgentOAuthRouteDependencies = {}) {
  return {
    GET: (request: Request) => handleGrantsList(request, dependencies),
    DELETE: (request: Request) => handleGrantsRevoke(request, dependencies),
  };
}
