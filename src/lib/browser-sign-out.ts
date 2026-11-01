/**
 * A sign-out made in this browser, told apart from a session that lapsed. Supabase reports both
 * to every tab as the same SIGNED_OUT, so whatever ends a session on purpose marks it first, and a
 * tab whose session ends reads the marks (owner, 2026-11-01: a sign-out in another tab clears an
 * open creator page, a lapse keeps it). A mark is the session it ended, so it never stands for a
 * later one. The last few are kept, so a tab that hears of its session's end late, after other
 * sign-outs, still finds its own.
 */

export const BROWSER_SIGN_OUT_KEY = 'magicbooklet:browser-sign-out:v1';
/** More sessions than a tab could still be catching up on. */
const KEPT_MARKS = 10;

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

/** The stored marks as they are written, or null: a snapshot a tab follows (`subscribeToBrowserSignOuts`). */
export function browserSignOutSnapshot(): string | null {
  try {
    return window.localStorage.getItem(BROWSER_SIGN_OUT_KEY);
  } catch {
    return null;
  }
}

/** Calls back whenever another tab of this browser marks a sign-out or takes one back. */
export function subscribeToBrowserSignOuts(onChange: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    // A null key is the whole storage cleared.
    if (event.key === BROWSER_SIGN_OUT_KEY || event.key === null) onChange();
  };
  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
}

function readMarks(snapshot: string | null): string[] {
  if (!snapshot) return [];
  try {
    const marks: unknown = JSON.parse(snapshot);
    return Array.isArray(marks) ? marks.filter((mark): mark is string => typeof mark === 'string') : [];
  } catch {
    return [];
  }
}

function sessionIdsOf(accessTokens: ReadonlyArray<string | null | undefined>): string[] {
  return accessTokens.map(accessTokenSessionId).filter((sessionId): sessionId is string => sessionId !== null);
}

function writeMarks(marks: string[]): void {
  try {
    if (marks.length === 0) window.localStorage.removeItem(BROWSER_SIGN_OUT_KEY);
    else window.localStorage.setItem(BROWSER_SIGN_OUT_KEY, JSON.stringify(marks.slice(-KEPT_MARKS)));
  } catch {
    // Storage refused: the other tabs take the ending for a lapse, as they did before the marks.
  }
}

/**
 * Marks the sessions the access tokens belong to as signed out here on purpose, before the
 * sign-out ends them in every tab. A token that names no session marks nothing.
 */
export function markBrowserSignOut(...accessTokens: Array<string | null | undefined>): void {
  const sessionIds = sessionIdsOf(accessTokens);
  if (sessionIds.length === 0) return;
  const kept = readMarks(browserSignOutSnapshot()).filter((mark) => !sessionIds.includes(mark));
  writeMarks([...kept, ...sessionIds]);
}

/** Takes these sessions' marks back, for a sign-out that failed and left them as they were. */
export function forgetBrowserSignOut(...accessTokens: Array<string | null | undefined>): void {
  const sessionIds = sessionIdsOf(accessTokens);
  const marks = readMarks(browserSignOutSnapshot());
  const kept = marks.filter((mark) => !sessionIds.includes(mark));
  if (kept.length !== marks.length) writeMarks(kept);
}

/**
 * Whether a sign-out made in this browser ended the session with this id, rather than a lapse or
 * a refusal. `snapshot`: the marks to read, the stored ones by default.
 */
export function wasSessionSignedOutInBrowser(
  sessionId: string | null,
  snapshot: string | null = browserSignOutSnapshot(),
): boolean {
  return sessionId !== null && readMarks(snapshot).includes(sessionId);
}

/** `wasSessionSignedOutInBrowser` for the session an access token belongs to. */
export function wasSignedOutInBrowser(accessToken: string | null | undefined): boolean {
  return wasSessionSignedOutInBrowser(accessTokenSessionId(accessToken));
}
