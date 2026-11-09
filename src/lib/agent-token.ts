/**
 * What makes a bearer token an agent's token, and the one route such a token may drive.
 *
 * An agent (Claude.ai, Claude Desktop, Claude Code, ChatGPT, Codex, Cursor) signs a creator in
 * through Supabase Auth's OAuth 2.1 server, which issues an ordinary Supabase JWT carrying the
 * `client_id` of the OAuth client that asked for it (`docs/plans/agent-mcp-server-plan-2026-11-09.md`).
 * An app or browser session carries no such claim. That claim is the whole distinction:
 *
 * - the MCP route requires it, so a copied app session cannot drive the server
 *   (`mcp-route-adapter-service.ts`, 403 `AGENT_TOKEN_REQUIRED`);
 * - every other API route refuses it, so a leaked agent token can do only what the consent
 *   screen said (`route-identity-admission.ts`, 403 `AGENT_TOKEN_NOT_ALLOWED`).
 *
 * Supabase binds a token to no resource (no RFC 8707 `resource` parameter), which is why the
 * route must. The phase 0 spike reads the claims a real agent token carries; if the rule turns
 * out to be a different claim, or a claim with a shape, it changes here and nowhere else.
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
