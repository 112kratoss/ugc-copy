/**
 * Which authorization server the MCP routes trust (`docs/plans/agent-token-broker-plan-2026-11-26.md`,
 * "The flag"). Read per request from `MCP_AUTHORIZATION_SERVER`:
 *
 * - `supabase` (and unset, and anything unrecognised): Supabase Auth's OAuth server, as before the
 *   app had one of its own. The app's `/oauth/*` endpoints answer 404.
 * - `both`: the cutover's proving stage. The metadata names the app, new connections get the app's
 *   opaque tokens, and a Supabase agent JWT issued earlier still works.
 * - `app`: the app alone. The MCP routes take its opaque tokens and refuse every JWT.
 *
 * The default is the old behaviour so that deploying the code changes nothing; the switch is the
 * owner's (the plan's cutover steps), and the follow-up that deletes the Supabase path makes `app`
 * the only behaviour.
 */

export type McpAuthorizationServer = 'supabase' | 'both' | 'app';

type Environment = Record<string, string | undefined>;

export function resolveMcpAuthorizationServer(env: Environment = process.env): McpAuthorizationServer {
  const value = env.MCP_AUTHORIZATION_SERVER?.trim().toLowerCase();
  return value === 'app' || value === 'both' ? value : 'supabase';
}

/** Whether the app's own authorization server answers: its endpoints, its metadata, its tokens. */
export function isAppAuthorizationServerEnabled(env: Environment = process.env): boolean {
  return resolveMcpAuthorizationServer(env) !== 'supabase';
}

/** Whether the MCP routes still take an agent JWT issued by Supabase Auth's OAuth server. */
export function areSupabaseAgentTokensAccepted(env: Environment = process.env): boolean {
  return resolveMcpAuthorizationServer(env) !== 'app';
}
