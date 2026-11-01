/**
 * A sign-out made in this browser, told apart from a session that lapsed. Supabase reports both
 * to every tab as the same SIGNED_OUT, so the tab that signs out marks the session first, and a
 * tab whose session ends reads the mark (owner, 2026-11-01: a sign-out in another tab clears an
 * open creator page, a lapse keeps it). The mark is the session it ended, so it never stands for
 * a later one.
 */

const BROWSER_SIGN_OUT_KEY = 'magicbooklet:browser-sign-out:v1';

/** The Supabase session an access token belongs to (its `session_id` claim), or null. */
export function accessTokenSessionId(accessToken: string | null | undefined): string | null {
  try {
    const payload = accessToken?.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const sessionId = (JSON.parse(json) as { session_id?: unknown }).session_id;
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Marks the session the access token belongs to as signed out here on purpose, before the
 * sign-out ends it in every tab. A token that names no session marks nothing.
 */
export function markBrowserSignOut(accessToken: string | null | undefined): void {
  const sessionId = accessTokenSessionId(accessToken);
  if (!sessionId) return;
  try {
    window.localStorage.setItem(BROWSER_SIGN_OUT_KEY, sessionId);
  } catch {
    // Storage refused: the other tabs take the ending for a lapse, as they did before the mark.
  }
}

/** Takes the mark back, for a sign-out whose call failed and left the session as it was. */
export function forgetBrowserSignOut(): void {
  try {
    window.localStorage.removeItem(BROWSER_SIGN_OUT_KEY);
  } catch {
    // Nothing to take back in a browser that refused it.
  }
}

/**
 * Whether a sign-out made in this browser ended the session the access token belongs to, rather
 * than a lapse or a refusal.
 */
export function wasSignedOutInBrowser(accessToken: string | null | undefined): boolean {
  const sessionId = accessTokenSessionId(accessToken);
  if (!sessionId) return false;
  try {
    return window.localStorage.getItem(BROWSER_SIGN_OUT_KEY) === sessionId;
  } catch {
    return false;
  }
}
