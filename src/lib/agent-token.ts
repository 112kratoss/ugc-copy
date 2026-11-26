/**
 * The two kinds of agent token this app knows, and the MCP routes' paths.
 *
 * An agent (Claude.ai, Claude Desktop, Claude Code, ChatGPT, Codex, Cursor) signs a creator in
 * through the app's own OAuth 2.1 authorization server (`docs/archive/agent-token-broker-plan-2026-11-26.md`),
 * whose access token is an opaque string with the prefix below: a row in this app's database and
 * nothing at Supabase. The MCP routes take that token and no other (`mcp-route-adapter-service.ts`).
 *
 * Before 2026-11-26 an agent signed in through Supabase Auth's OAuth server instead, which issued
 * an ordinary Supabase JWT carrying the `client_id` of the OAuth client that asked for it. That
 * server is switched off, but the rule for such a token stays, so one could never become a session
 * here again: every API route refuses it (`route-identity-admission.ts`, 403
 * `AGENT_TOKEN_NOT_ALLOWED`), the server-rendered pages refuse it as a session
 * (`supabase-server.ts`), and so do the media routes' cookie branch (`media-route-shared.ts`) and
 * the web's own account routes (`agent-oauth-route-adapter-service.ts`). The MCP routes refuse
 * every JWT. An app or browser session carries no such claim.
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

type Claims = Record<string, unknown> | null | undefined;

/** The OAuth client a Supabase agent JWT was issued to, or null for an app or browser session's token. */
export function agentTokenClientId(claims: Claims): string | null {
  const clientId = claims?.[AGENT_TOKEN_CLAIM];
  if (typeof clientId !== 'string') return null;
  const trimmed = clientId.trim();
  return trimmed ? trimmed : null;
}

export function isAgentToken(claims: Claims): boolean {
  return agentTokenClientId(claims) !== null;
}

/** The prefix of an access token the app's own authorization server issued (`agent-oauth-tokens.ts`). */
export const APP_AGENT_ACCESS_TOKEN_PREFIX = 'mbat_';

const APP_AGENT_ACCESS_TOKEN_PATTERN = /^mbat_[A-Za-z0-9_-]{43}$/;

/**
 * Whether a bearer token has the shape of the app's own agent access token: the prefix and 256
 * random bits in base64url. Shape only: whether it is live is the database's answer
 * (`agent-oauth-admission.ts`). A JWT never has this shape, so the test also tells the two apart.
 */
export function isAppAgentAccessToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && APP_AGENT_ACCESS_TOKEN_PATTERN.test(token);
}
