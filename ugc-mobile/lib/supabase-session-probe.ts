/**
 * What Supabase says about the session behind an access token.
 *
 * - `alive`: it accepted the token.
 * - `ended`: the session, or the user it belonged to, no longer exists.
 * - `refused`: it answered cleanly but refused the token for another reason
 *   (expired, or signed with a key it no longer trusts). A refresh settles it.
 * - `unknown`: no clean answer. A network failure, a timeout, a 5xx or a rate
 *   limit says nothing about the session, so nothing may be concluded from it.
 */
export type SessionProbeVerdict = 'alive' | 'ended' | 'refused' | 'unknown';

export const SESSION_PROBE_TIMEOUT_MS = 10_000;

const SESSION_ENDED_CODES = new Set(['session_not_found', 'user_not_found']);

/**
 * Asks Supabase whether the session behind `accessToken` still exists.
 *
 * Deliberately a plain request outside the Supabase client. It holds no auth-js
 * lock and is aborted, never raced, when Supabase is slow. Above all it cannot
 * sign anyone out as a side effect. A refresh can: auth-js deletes the local
 * session on any refresh failure other than a network error or a 502-504, so
 * using a refresh as the check would turn an auth outage (500s, a rate limit
 * shared by a whole carrier's NAT) into a sign-out for every device that asked.
 */
export async function probeSupabaseSession({
  supabaseUrl,
  publishableKey,
  accessToken,
  fetcher = fetch,
  timeoutMs = SESSION_PROBE_TIMEOUT_MS,
}: {
  supabaseUrl: string;
  publishableKey: string;
  accessToken: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): Promise<SessionProbeVerdict> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
    if (response.ok) return 'alive';
    if (response.status !== 401 && response.status !== 403) return 'unknown';

    const body: unknown = await response.json().catch(() => null);
    return SESSION_ENDED_CODES.has(errorCodeOf(body) ?? '') ? 'ended' : 'refused';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Supabase Auth names the error in `error_code`, or in `code` for clients that
 * opt into its 2024-01-01 response format (where `code` is no longer the
 * numeric status). Either spelling is read so a gateway change cannot hide it.
 */
function errorCodeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { error_code: errorCode, code } = body as { error_code?: unknown; code?: unknown };
  if (typeof errorCode === 'string') return errorCode;
  return typeof code === 'string' ? code : null;
}
