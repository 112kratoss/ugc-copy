/**
 * What makes a bearer token an agent's token, and the routes such a token may drive.
 *
 * An agent (Claude.ai, Claude Desktop, Claude Code, ChatGPT, Codex, Cursor) signs a creator in
 * through Supabase Auth's OAuth 2.1 server, which issues an ordinary Supabase JWT carrying the
 * `client_id` of the OAuth client that asked for it (`docs/plans/agent-mcp-server-plan-2026-11-09.md`).
 * An app or browser session carries no such claim. That claim is the whole distinction on this
 * app's own surfaces:
 *
 * - the MCP route requires it, so a copied app session cannot drive the server
 *   (`mcp-route-adapter-service.ts`, 403 `AGENT_TOKEN_REQUIRED`);
 * - every other API route refuses it (`route-identity-admission.ts`, 403
 *   `AGENT_TOKEN_NOT_ALLOWED`), the server-rendered pages refuse it as a session
 *   (`supabase-server.ts`) and so do the media routes' cookie branch (`media-route-shared.ts`),
 *   so an agent token drives no API route of this app but the MCP routes (`/api/mcp` and its
 *   posting-only form, `/api/mcp/posts`), and no page or cookie session.
 *
 * What the claim does not do: bind the token to this app. Supabase binds a token to no resource
 * (no RFC 8707 `resource` parameter), and against the project's own endpoints (PostgREST,
 * Storage, Auth) an agent token is the creator's session under RLS, like any user token. The
 * remedy for a leaked token is revocation of the grant, which deletes its sessions, and the
 * one-hour expiry. The phase 0 spike read the claims a real agent token carries
 * (`docs/research/mcp-oauth-spike-2026-11-09.md`); if the rule changes, it changes here.
 *
 * That is the token Supabase issues, and the reason the app has an authorization server of its
 * own (`docs/plans/agent-token-broker-plan-2026-11-26.md`): its access token is an opaque string
 * with the prefix below, a row in this app's database and nothing at Supabase. Which of the two
 * the MCP routes take is `MCP_AUTHORIZATION_SERVER` (`agent-oauth-mode.ts`); once it is `app`,
 * no JWT of any kind is taken there.
 */

export const AGENT_TOKEN_CLAIM = 'client_id';

/** The MCP server's path: every tool, media creation included. */
export const MCP_ROUTE_PATH = '/api/mcp';

/**
 * The posting-only MCP server's path: the tools that stage a file, publish, read and delete a
 * post and list the creator's creations, and nothing that starts a run or spends credits
 * (`mcp-surfaces.ts`). It is the server listed in Claude's connectors directory, whose policy
 * takes no connector that generates media.
 */
export const MCP_POSTS_ROUTE_PATH = '/api/mcp/posts';

/** The API paths an agent token is admitted to: the MCP routes, and nothing else. */
export const MCP_ROUTE_PATHS: readonly string[] = [MCP_ROUTE_PATH, MCP_POSTS_ROUTE_PATH];

type Claims = Record<string, unknown> | null | undefined;

/** The OAuth client the token was issued to, or null for an app or browser session's token. */
export function agentTokenClientId(claims: Claims): string | null {
  const clientId = claims?.[AGENT_TOKEN_CLAIM];
  if (typeof clientId !== 'string') return null;
  const trimmed = clientId.trim();
  return trimmed ? trimmed : null;
}

export function isAgentToken(claims: Claims): boolean {
  return agentTokenClientId(claims) !== null;
}

/** Whether a request path takes an agent token at all: only the MCP routes do. */
export function routeAcceptsAgentToken(pathname: string): boolean {
  return MCP_ROUTE_PATHS.includes(pathname);
}

/** The prefix of an access token the app's own authorization server issued (`agent-oauth-tokens.ts`). */
export const APP_AGENT_ACCESS_TOKEN_PREFIX = 'mbat_';

const APP_AGENT_ACCESS_TOKEN_PATTERN = /^mbat_[A-Za-z0-9_-]{43}$/;

/**
 * Whether a bearer token has the shape of the app's own agent access token: the prefix and 256
 * random bits in base64url. Shape only: whether it is live is the database's answer
 * (`agent-oauth-admission.ts`). A JWT never has this shape, so the test also tells the two apart.
 */
export function isAppAgentAccessToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && APP_AGENT_ACCESS_TOKEN_PATTERN.test(token);
}
