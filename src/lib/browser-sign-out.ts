/**
 * A sign-out made in this browser, told apart from a session that lapsed. Supabase reports both
 * to every tab as the same SIGNED_OUT, so the tab that signs out marks the session first, and a
 * tab whose session ends reads the mark (owner, 2026-11-01: a sign-out in another tab clears an
 * open creator page, a lapse keeps it). The mark names the session it ended, so it never stands
 * for a later one.
 */

const BROWSER_SIGN_OUT_KEY = 'magicbooklet:browser-sign-out:v1';

type MarkedSession = { access_token: string; user: { id: string } };

type BrowserSignOutMark = { userId: string; sessionId: string | null };

/** The Supabase session an access token belongs to (its `session_id` claim), or null. */
export function accessTokenSessionId(accessToken: string): string | null {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const sessionId = (JSON.parse(json) as { session_id?: unknown }).session_id;
    return typeof sessionId === 'string' && sessionId ? sessionId : null;
  } catch {
    return null;
  }
}

/** Marks the session as signed out here on purpose, before the sign-out ends it in every tab. */
export function markBrowserSignOut(session: MarkedSession): void {
  const mark: BrowserSignOutMark = { userId: session.user.id, sessionId: accessTokenSessionId(session.access_token) };
  try {
    window.localStorage.setItem(BROWSER_SIGN_OUT_KEY, JSON.stringify(mark));
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

/** Whether a sign-out made in this browser ended this session, rather than a lapse or a refusal. */
export function wasSignedOutInBrowser(session: MarkedSession): boolean {
  let mark: Partial<BrowserSignOutMark> | null = null;
  try {
    const raw = window.localStorage.getItem(BROWSER_SIGN_OUT_KEY);
    mark = raw ? (JSON.parse(raw) as Partial<BrowserSignOutMark>) : null;
  } catch {
    return false;
  }
  if (!mark || mark.userId !== session.user.id) return false;
  // The same session: where neither token names one, the same account.
  return (mark.sessionId ?? null) === accessTokenSessionId(session.access_token);
}
