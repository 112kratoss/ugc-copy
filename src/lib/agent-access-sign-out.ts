/**
 * "Sign out everywhere", for the app's own authorization server
 * (`docs/plans/agent-token-broker-plan-2026-11-26.md`): ends every grant of the account, with the
 * session's token, before that session is ended.
 *
 * An agent's access was one of the account's sessions while Supabase issued its token, so signing
 * out of every device ended it, and the consent page says it does. The app's own grants are not
 * sessions, so the shell ends them here. It is a module of its own, with no import, because the
 * shell on every page loads it.
 */

/** The grants route (`APP_GRANTS_API_PATH` in `connected-apps.ts`, which a test holds this to). */
export const AGENT_ACCESS_GRANTS_PATH = '/api/oauth/grants';

type GrantsFetch = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok'>>;

/**
 * True once the server has confirmed that no grant of the account is left (with the app's server
 * switched off it confirms at once: there are none). False otherwise, so the caller does not go on
 * to say every device is signed out while an agent may not be.
 */
export async function endAllAgentAccess(options: {
  accessToken: string | null | undefined;
  fetch?: GrantsFetch;
}): Promise<boolean> {
  if (!options.accessToken) return false;
  const send: GrantsFetch = options.fetch ?? ((input, init) => fetch(input, init));
  try {
    const response = await send(AGENT_ACCESS_GRANTS_PATH, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.accessToken}` },
      body: JSON.stringify({ all: true }),
      credentials: 'omit',
      cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  }
}
