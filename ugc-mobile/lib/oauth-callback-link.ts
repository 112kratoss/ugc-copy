/**
 * The address Google sign-in comes back to (`lib/google-auth.ts`), and what the router does with
 * it when the system hands it to the app (`app/+native-intent.tsx`).
 *
 * On Android the redirect reaches the running app twice: the Custom Tab's auth session reads it,
 * and the app's activity receives it as a deep link too. expo-router navigated that deep link to
 * `/oauth/callback`, a path no screen has, so "Not Found" covered the sign-in page for the second
 * or so the code took to be exchanged (owner's video, 2026-11-28). The auth session is the only
 * reader the link needs: the router leaves it alone. iOS's auth session keeps the redirect to
 * itself, so there it never arrives.
 *
 * Pure (no Expo or React Native imports), so vitest covers it.
 */

/** The app's own scheme, and the dev client's (`exp+<slug>`), which claims the same links. */
const APP_SCHEMES = ['magicbooklet', 'exp+magicbooklet-mobile'] as const;

export const OAUTH_CALLBACK_SCHEME = APP_SCHEMES[0];
export const OAUTH_CALLBACK_PATH = 'oauth/callback';

/** Where a start by the callback link goes: no sign-in is waiting for it any more. */
export const OAUTH_CALLBACK_COLD_START_ROUTE = '/';

const CALLBACK_PATH = /^\/*oauth\/callback\/?(?:[?#]|$)/i;

/**
 * Whether a link the system handed the app is the sign-in redirect: `magicbooklet://oauth/callback`
 * with any query (the code, or the provider's error), the triple-slash form, the dev client's
 * scheme, or the bare path the router may be given instead.
 */
export function isOAuthCallbackLink(link: string): boolean {
  const value = link.trim();
  const schemeEnd = value.indexOf('://');
  if (schemeEnd === -1) return CALLBACK_PATH.test(value);
  const scheme = value.slice(0, schemeEnd).toLowerCase();
  if (!(APP_SCHEMES as readonly string[]).includes(scheme)) return false;
  return CALLBACK_PATH.test(value.slice(schemeEnd + 3));
}

/**
 * expo-router's `redirectSystemPath` for the sign-in redirect: `null` while the app runs (the
 * router stays where it is, on the sign-in page, and the auth session finishes the sign-in), Home
 * when the link started the app (Android ended the process while Google's page was open, and the
 * session that asked for it went with it). Any other link passes through unchanged.
 */
export function routeForSystemLink(path: string, initial: boolean): string | null {
  if (!isOAuthCallbackLink(path)) return path;
  return initial ? OAUTH_CALLBACK_COLD_START_ROUTE : null;
}
