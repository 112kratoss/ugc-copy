/**
 * What makes a bearer token an agent's token, and the one route such a token may drive.
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
 *   so an agent token drives no API route of this app but `/api/mcp`, and no page or cookie
 *   session.
 *
 * What the claim does not do: bind the token to this app. Supabase binds a token to no resource
 * (no RFC 8707 `resource` parameter), and against the project's own endpoints (PostgREST,
 * Storage, Auth) an agent token is the creator's session under RLS, like any user token. The
 * remedy for a leaked token is revocation of the grant, which deletes its sessions, and the
 * one-hour expiry. The phase 0 spike read the claims a real agent token carries
 * (`docs/research/mcp-oauth-spike-2026-11-09.md`); if the rule changes, it changes here.
 */

export const AGENT_TOKEN_CLAIM = 'client_id';

/** The one API path an agent token is admitted to. */
export const MCP_ROUTE_PATH = '/api/mcp';

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

/** Whether a request path takes an agent token at all: only the MCP server does. */
export function routeAcceptsAgentToken(pathname: string): boolean {
  return pathname === MCP_ROUTE_PATH;
}
