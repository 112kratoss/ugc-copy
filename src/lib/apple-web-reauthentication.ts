import { siteConfig } from '@/lib/seo';

/**
 * Continue with Apple on the website for deleting an account with an Apple
 * identity. The deletion page sends the person to Apple's authorize page as
 * the website's Services ID, and Apple sends them back to the page with a
 * one-time code, which `DELETE /api/account` redeems with the same Services ID
 * and return URL to check the Apple user and revoke Apple's authorization
 * (`apple-account-deletion-service.ts`). Supabase's web sign-in redeems its own
 * code, so it has none to give the deletion. The runbook's "Sign in with Apple
 * on the web" registers the return URL on the Services ID.
 */

const APPLE_AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';

/** Where Apple sends the person back: the deletion page itself. */
export const APPLE_WEB_RETURN_PATH = '/delete-account';

/**
 * The website's Services ID, or null where none is set (a local server; the
 * E2E server has a placeholder): the page then sends an account with an Apple
 * identity to the iPhone app.
 */
export function getAppleWebClientId(): string | null {
  return process.env.NEXT_PUBLIC_APPLE_SERVICES_ID?.trim() || null;
}

/** The return URL on the site's own origin, the one registered with Apple. */
export function getAppleWebReturnUrl(siteUrl: string = siteConfig.siteUrl): string {
  return new URL(APPLE_WEB_RETURN_PATH, siteUrl).toString();
}

/**
 * Continue with Apple for a page on `origin`, or null without a Services ID.
 * Apple returns only to the registered address, so `returnsHere` is false on
 * any other origin (a preview, a local server, or the www host when it is not
 * the site's).
 */
export function getAppleWebAuthorization(origin: string): {
  clientId: string;
  returnUrl: string;
  returnsHere: boolean;
} | null {
  const clientId = getAppleWebClientId();
  if (!clientId) return null;
  const returnUrl = getAppleWebReturnUrl();
  return { clientId, returnUrl, returnsHere: new URL(returnUrl).origin === origin };
}

/**
 * Apple's authorize page for a deletion. No scope: Apple then answers in the
 * address's fragment, which no server log or Referer carries, and the deletion
 * needs no name or email. `state` comes back with the answer.
 */
export function buildAppleWebAuthorizationUrl({
  clientId,
  returnUrl,
  state,
}: {
  clientId: string;
  returnUrl: string;
  state: string;
}): string {
  const url = new URL(APPLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: returnUrl,
    response_type: 'code',
    response_mode: 'fragment',
    state,
  }).toString();
  return url.toString();
}

/** Apple's answer: a code, or an error (`user_cancelled_authorize` for its Cancel). */
export type AppleWebAuthorizationAnswer =
  | { state: string; code: string }
  | { state: string; error: string };

/** Apple's answer in an address's fragment, or null when the fragment holds none. */
export function readAppleWebAuthorizationAnswer(hash: string): AppleWebAuthorizationAnswer | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const state = params.get('state');
  if (!state) return null;
  const code = params.get('code');
  if (code) return { state, code };
  const error = params.get('error');
  return error ? { state, error } : null;
}

/** A Continue with Apple a tab started: the state Apple is given, and the account that pressed it. */
export type AppleWebAuthorizationStart = { state: string; userId: string };

const START_STORAGE_KEY = 'magicbooklet:apple-account-deletion';
/**
 * How long a start answers Apple: a person can take a while on Apple's page, and
 * may come back to it with Back and confirm again (a new code for the same
 * state); Apple's own code lives five minutes.
 */
export const APPLE_WEB_AUTHORIZATION_START_LIFETIME_MS = 10 * 60 * 1000;

function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps the start in this tab for Apple's answer, which arrives in a new load of the page; false when the browser refuses. */
export function rememberAppleWebAuthorizationStart(start: AppleWebAuthorizationStart, now = Date.now()): boolean {
  const storage = tabStorage();
  if (!storage) return false;
  try {
    storage.setItem(START_STORAGE_KEY, JSON.stringify({ ...start, startedAt: now }));
    return true;
  } catch {
    return false;
  }
}

/** The start this tab kept, if any, while it still answers Apple. */
export function readAppleWebAuthorizationStart(now = Date.now()): AppleWebAuthorizationStart | null {
  try {
    const kept: unknown = JSON.parse(tabStorage()?.getItem(START_STORAGE_KEY) ?? 'null');
    if (kept && typeof kept === 'object') {
      const { state, userId, startedAt } = kept as Record<string, unknown>;
      const fresh = typeof startedAt === 'number' && now - startedAt >= 0
        && now - startedAt <= APPLE_WEB_AUTHORIZATION_START_LIFETIME_MS;
      if (fresh && typeof state === 'string' && state && typeof userId === 'string' && userId) return { state, userId };
    }
  } catch {
    // A value the browser garbled holds no start.
  }
  return null;
}

/** Once the account is deleted, or the tab starts another. */
export function forgetAppleWebAuthorizationStart(): void {
  try {
    tabStorage()?.removeItem(START_STORAGE_KEY);
  } catch {
    // Blocked storage kept nothing to forget.
  }
}

/** Why an answer brings no code to use. */
export type AppleWebAuthorizationRefusal = 'elsewhere' | 'cancelled' | 'not-confirmed';

/**
 * What Apple's answer allows the page: its code only for the start this tab
 * kept and for the account that started it, so a link to Apple's page from
 * anywhere else cannot bring a deletion; otherwise why nothing happens. Null
 * without an answer.
 */
export function judgeAppleWebAuthorizationAnswer(
  answer: AppleWebAuthorizationAnswer | null,
  start: AppleWebAuthorizationStart | null,
  userId: string | null,
): { code: string } | { refusal: AppleWebAuthorizationRefusal } | null {
  if (!answer) return null;
  if (!start || start.state !== answer.state || start.userId !== userId) return { refusal: 'elsewhere' };
  if ('code' in answer) return { code: answer.code };
  return { refusal: answer.error === 'user_cancelled_authorize' ? 'cancelled' : 'not-confirmed' };
}
