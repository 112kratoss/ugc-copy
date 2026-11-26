import { isCodeChallenge } from '@/lib/agent-oauth-tokens';
import { isPostingOnlyClientId } from '@/lib/mcp-client-directory';
import { MCP_SURFACE_ROUTE_PATHS, type McpSurface } from '@/lib/mcp-surfaces';

/**
 * What the app's authorization server accepts in a request, with no database and no HTTP in it
 * (`docs/plans/agent-token-broker-plan-2026-11-26.md`, "Endpoints"). OAuth 2.1 for MCP:
 * authorization code with PKCE S256, pre-registered clients, exact redirect URIs, and a `resource`
 * (RFC 8707) that binds a grant to one of the two MCP servers.
 */

export type AgentOAuthAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export type AgentOAuthClient = {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  redirectUris: readonly string[];
  tokenEndpointAuthMethod: AgentOAuthAuthMethod;
  /** base64url(SHA-256(secret)) for a confidential client; null for a public one. */
  clientSecretHash: string | null;
  /** The widest server a grant to this client may reach. */
  surface: McpSurface;
  disabledAt: string | null;
};

/** The scope every grant carries. Access is the grant's surface, never a scope. */
export const AGENT_OAUTH_SCOPE = 'mcp';

export const AGENT_OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
export const AGENT_OAUTH_TOKEN_PATH = '/oauth/token';
export const AGENT_OAUTH_REVOKE_PATH = '/oauth/revoke';

const MAX_STATE_LENGTH = 2048;
const MAX_SCOPE_LENGTH = 512;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** An OAuth error as RFC 6749 names it, with the status its endpoint answers. */
export class AgentOAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: 400 | 401 | 429 | 503 = 400,
  ) {
    super(description);
    this.name = 'AgentOAuthError';
  }
}

/**
 * A request parameter's one value, or null when it was not sent. OAuth 2.1 forbids a parameter
 * sent more than once: two `redirect_uri`s or two `client_id`s is how a request means one thing to
 * the server and another to whatever reads it next.
 */
export function singleParameter(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) {
    throw new AgentOAuthError('invalid_request', `The ${name} parameter was sent more than once.`);
  }
  const value = values[0];
  return value === undefined || value === '' ? null : value;
}

export function isClientId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_ID_PATTERN.test(value);
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** The resource identifier of an MCP server on this origin: what a client names in `resource`. */
export function agentOAuthResource(siteOrigin: string, surface: McpSurface): string {
  return `${siteOrigin}${MCP_SURFACE_ROUTE_PATHS[surface]}`;
}

/**
 * The server a `resource` names: one of this origin's two MCP URLs (a trailing slash aside), or
 * null for anything else. A resource with a query or a fragment is not one of them.
 */
export function surfaceOfResource(resource: string, siteOrigin: string): McpSurface | null {
  const asked = withoutTrailingSlash(resource.trim());
  for (const surface of ['full', 'posts'] as const) {
    if (asked === agentOAuthResource(siteOrigin, surface)) return surface;
  }
  return null;
}

/**
 * The widest server a client may be granted. Posting-only is said in two places and either is
 * enough: the client's row, and the code's own list (`MCP_POSTING_ONLY_CLIENT_IDS`), so a row
 * registered or imported as `full` by mistake does not widen a client the code names.
 */
export function widestSurfaceOf(client: Pick<AgentOAuthClient, 'clientId' | 'surface'>): McpSurface {
  return client.surface === 'posts' || isPostingOnlyClientId(client.clientId) ? 'posts' : 'full';
}

/**
 * The server a grant is for: the one `resource` names, or the client's own widest server when the
 * client sent none. A posting-only client is never granted the full server.
 */
export function resolveGrantSurface(
  client: Pick<AgentOAuthClient, 'clientId' | 'surface'>,
  resource: string | null,
  siteOrigin: string,
): McpSurface | null {
  const widest = widestSurfaceOf(client);
  if (resource === null) return widest;
  const surface = surfaceOfResource(resource, siteOrigin);
  if (!surface) return null;
  if (widest === 'posts' && surface !== 'posts') return null;
  return surface;
}

/** Whether a redirect URI is one the client registered: the same string, nothing looser. */
export function isRegisteredRedirectUri(client: Pick<AgentOAuthClient, 'redirectUris'>, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  surface: McpSurface;
  state: string | null;
  scope: string | null;
  codeChallenge: string;
};

export type AuthorizeRequestCheck =
  | { ok: true; request: AuthorizeRequest }
  /** Nothing can be sent to the client: who it is, or where it is sent back to, is not established. */
  | { ok: false; kind: 'page'; description: string }
  /** The client and its redirect URI are established, so the refusal goes back to it. */
  | { ok: false; kind: 'redirect'; redirectUri: string; state: string | null; error: string; description: string };

/**
 * What `/oauth/authorize` decides before anything is stored. `findClient` answers for a
 * well-formed client id only.
 *
 * The order is the standard's: the client and the redirect URI first, and until both hold the
 * person is shown a page, because a refusal sent to an unverified address is an open redirect.
 * After that every refusal is the client's to read, at its own redirect URI.
 */
export async function checkAuthorizeRequest(
  params: URLSearchParams,
  options: { siteOrigin: string; findClient: (clientId: string) => Promise<AgentOAuthClient | null> },
): Promise<AuthorizeRequestCheck> {
  let clientId: string | null;
  let redirectUri: string | null;
  try {
    clientId = singleParameter(params, 'client_id');
    redirectUri = singleParameter(params, 'redirect_uri');
  } catch (error) {
    return { ok: false, kind: 'page', description: error instanceof AgentOAuthError ? error.description : 'The request is malformed.' };
  }
  if (!isClientId(clientId)) return { ok: false, kind: 'page', description: 'The app that sent you here did not say who it is.' };
  const client = await options.findClient(clientId);
  if (!client || client.disabledAt) {
    return { ok: false, kind: 'page', description: 'The app that sent you here is not registered with Magicbooklet.' };
  }
  if (!redirectUri || !isRegisteredRedirectUri(client, redirectUri)) {
    return { ok: false, kind: 'page', description: 'The app that sent you here asked to return to an address it is not registered with.' };
  }

  let state: string | null = null;
  const refuse = (error: string, description: string): AuthorizeRequestCheck => (
    { ok: false, kind: 'redirect', redirectUri: redirectUri as string, state, error, description }
  );
  try {
    state = singleParameter(params, 'state');
    if (state !== null && state.length > MAX_STATE_LENGTH) {
      state = null;
      return refuse('invalid_request', 'The state parameter is too long.');
    }
    const responseType = singleParameter(params, 'response_type');
    if (responseType !== 'code') {
      return refuse(responseType === null ? 'invalid_request' : 'unsupported_response_type', 'response_type must be code.');
    }
    const challenge = singleParameter(params, 'code_challenge');
    const method = singleParameter(params, 'code_challenge_method');
    if (challenge === null) return refuse('invalid_request', 'code_challenge is required (PKCE).');
    if (method !== 'S256') return refuse('invalid_request', 'code_challenge_method must be S256.');
    if (!isCodeChallenge(challenge)) return refuse('invalid_request', 'code_challenge is not an S256 challenge.');
    const scope = singleParameter(params, 'scope');
    if (scope !== null && scope.length > MAX_SCOPE_LENGTH) return refuse('invalid_scope', 'The scope parameter is too long.');
    const surface = resolveGrantSurface(client, singleParameter(params, 'resource'), options.siteOrigin);
    if (!surface) return refuse('invalid_target', 'resource must be a Magicbooklet MCP server this app may connect to.');
    return {
      ok: true,
      request: { clientId: client.clientId, redirectUri, surface, state, scope, codeChallenge: challenge },
    };
  } catch (error) {
    if (error instanceof AgentOAuthError) return refuse(error.error, error.description);
    throw error;
  }
}

/**
 * The client's redirect URI with the answer in its query: a code, or an error. The URI's own
 * query is kept, nothing goes in a fragment, and `state` is echoed exactly as it was sent.
 */
export function buildAuthorizationResponseUrl(
  redirectUri: string,
  answer: { code: string } | { error: string; description?: string },
  state: string | null,
): string {
  const url = new URL(redirectUri);
  // A registered redirect URI is https, or http on a loopback host (the table holds that). The
  // answer is never built for anything else, whatever a row came to hold.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The redirect URI is not an http(s) address.');
  }
  if ('code' in answer) {
    url.searchParams.set('code', answer.code);
  } else {
    url.searchParams.set('error', answer.error);
    if (answer.description) url.searchParams.set('error_description', answer.description);
  }
  if (state !== null) url.searchParams.set('state', state);
  return url.toString();
}

export type ClientCredentials = {
  clientId: string;
  /** The secret a confidential client sent, in the body or the Basic header; null when none was. */
  clientSecret: string | null;
  /** How the secret arrived, so a failure can answer with the matching challenge. */
  via: 'basic' | 'post' | 'none';
};

function decodeBasicCredentials(authorization: string): { id: string; secret: string } | null {
  const match = authorization.match(/^Basic\s+([A-Za-z0-9+/=_-]+)$/iu);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  try {
    // RFC 6749 section 2.3.1: both halves are form-urlencoded before they are joined.
    return {
      id: decodeURIComponent(decoded.slice(0, separator).replace(/\+/gu, ' ')),
      secret: decodeURIComponent(decoded.slice(separator + 1).replace(/\+/gu, ' ')),
    };
  } catch {
    return null;
  }
}

/**
 * Who a token or revocation request says it is from: `client_id` in the body, with a secret there
 * or in a Basic header for a confidential client. Credentials in both places are refused, as is
 * a body id that disagrees with the header's.
 */
export function readClientCredentials(form: URLSearchParams, authorizationHeader: string | null): ClientCredentials {
  const bodyId = singleParameter(form, 'client_id');
  const bodySecret = singleParameter(form, 'client_secret');
  const header = authorizationHeader?.trim() ?? '';
  if (/^Basic\s/iu.test(header)) {
    const basic = decodeBasicCredentials(header);
    if (!basic || !isClientId(basic.id)) throw new AgentOAuthError('invalid_client', 'The client credentials are malformed.', 401);
    if (bodySecret !== null) throw new AgentOAuthError('invalid_request', 'Send the client secret in one place.');
    if (bodyId !== null && bodyId !== basic.id) throw new AgentOAuthError('invalid_request', 'client_id does not match the Authorization header.');
    return { clientId: basic.id, clientSecret: basic.secret, via: 'basic' };
  }
  if (!isClientId(bodyId)) throw new AgentOAuthError('invalid_client', 'client_id is required.', 401);
  return bodySecret === null
    ? { clientId: bodyId, clientSecret: null, via: 'none' }
    : { clientId: bodyId, clientSecret: bodySecret, via: 'post' };
}

export type TokenGrantRequest =
  | { grantType: 'authorization_code'; code: string; codeVerifier: string; redirectUri: string | null; resource: string | null }
  | { grantType: 'refresh_token'; refreshToken: string };

/** The grant a token request asks for; its secrets are checked for shape by the service. */
export function readTokenGrantRequest(form: URLSearchParams): TokenGrantRequest {
  const grantType = singleParameter(form, 'grant_type');
  if (grantType === 'authorization_code') {
    const code = singleParameter(form, 'code');
    const codeVerifier = singleParameter(form, 'code_verifier');
    if (!code) throw new AgentOAuthError('invalid_request', 'code is required.');
    if (!codeVerifier) throw new AgentOAuthError('invalid_request', 'code_verifier is required (PKCE).');
    return {
      grantType,
      code,
      codeVerifier,
      redirectUri: singleParameter(form, 'redirect_uri'),
      resource: singleParameter(form, 'resource'),
    };
  }
  if (grantType === 'refresh_token') {
    const refreshToken = singleParameter(form, 'refresh_token');
    if (!refreshToken) throw new AgentOAuthError('invalid_request', 'refresh_token is required.');
    return { grantType, refreshToken };
  }
  if (grantType === null) throw new AgentOAuthError('invalid_request', 'grant_type is required.');
  throw new AgentOAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
}
