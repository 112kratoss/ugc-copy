/**
 * The Supabase session an access token belongs to: its `session_id` claim,
 * which every token refreshed in that session keeps and a new sign-in does not.
 * Null for a token it cannot read. Read only, never verified: it names the
 * session this phone holds for its own bookkeeping (the push registration it
 * last had confirmed), and authorises nothing.
 */
export function supabaseSessionId(accessToken: string | null | undefined): string | null {
  const payload = accessToken?.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    const sessionId = claims && typeof claims === 'object' ? (claims as { session_id?: unknown }).session_id : null;
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
  } catch {
    return null;
  }
}
