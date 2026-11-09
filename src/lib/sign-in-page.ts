import { isCreatorSignUpReturn } from '@/lib/auth-onboarding';

/**
 * The sign-in page's rules (`src/app/login/`), the web's copy of the app's one sign-in page
 * (`ugc-mobile/components/sign-in-wall.tsx`, #731): a moving wall of creations behind "Start
 * filling your Magic Booklet", Apple and Google, and the email form the same page turns into.
 */

/** The page's two halves: the ways in, and the email form it turns into in place. */
export type SignInHalf = 'choose' | 'email';

/** `?email=1`: the page is on its email form, as the app's `/auth?email=1` opens. */
export const SIGN_IN_EMAIL_PARAM = 'email';

/**
 * `?recovery=1`: an expired reset link (`/auth/reset-password`, `/auth/auth-code-error`) or an
 * older app's "Forgot password?". The page opens on the email form with a notice saying how to
 * get back in, as no reset mail can be sent.
 */
export const SIGN_IN_RECOVERY_PARAM = 'recovery';

/** The half a visit opens on, from the query the server read. */
export function signInHalfForQuery(query: { email?: string; recovery?: string }): SignInHalf {
  return query.email === '1' || query.recovery === '1' ? 'email' : 'choose';
}

/** The half an address shows: the one the browser's Back and Forward land on. */
export function signInHalfAt(href: string): SignInHalf {
  try {
    return new URL(href, 'https://magicbooklet.local').searchParams.get(SIGN_IN_EMAIL_PARAM) === '1' ? 'email' : 'choose';
  } catch {
    return 'choose';
  }
}

/**
 * The page's own address with `half` showing, from the address it is at: the email form adds
 * `email=1`; the choices take it away, with the recovery notice that belongs to the form. The
 * return (`returnUrl`, `next` or `redirect`) and anything else in the query stay.
 */
export function signInHalfPath(href: string, half: SignInHalf): string {
  const url = new URL(href, 'https://magicbooklet.local');
  if (half === 'email') {
    url.searchParams.set(SIGN_IN_EMAIL_PARAM, '1');
  } else {
    url.searchParams.delete(SIGN_IN_EMAIL_PARAM);
    url.searchParams.delete(SIGN_IN_RECOVERY_PARAM);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Where "Sign in" with email goes before the page's script has run, when a click is the
 * browser's own: the same page on its email form, back to the same place.
 */
export function signInEmailHref(redirectTo: string): string {
  return `/login?returnUrl=${encodeURIComponent(redirectTo)}&${SIGN_IN_EMAIL_PARAM}=1`;
}

/**
 * The line a sign-in from a creator's Generate adds (it replaced the creators' sign-up sheet,
 * owner 2026-11-09): what the visitor set up is kept, and nothing runs by itself. Only that
 * hand-over (`?handover=`) says so; a creator reached any other way keeps no visitor's draft.
 */
export const CREATOR_RETURN_NOTE = 'Your prompt and images stay, and nothing runs until you press Generate.';

export function creatorReturnNote(redirectTo: string): string | null {
  return isCreatorSignUpReturn(redirectTo) ? CREATOR_RETURN_NOTE : null;
}

/**
 * Whether Close can step back to a page of this site, as the app's sign-in steps back when it
 * can (`leaveAuthScreen`). The Navigation API knows this tab's earlier pages of this origin;
 * where a browser lacks it, a referrer of this origin stands in, which a link from elsewhere, a
 * typed address and a new tab do not give. Otherwise Close goes Home.
 */
export function hasSameSiteHistory(win: Window = window): boolean {
  const navigation = (win as Window & { navigation?: { canGoBack?: unknown } }).navigation;
  if (typeof navigation?.canGoBack === 'boolean') return navigation.canGoBack;
  try {
    return Boolean(win.document.referrer) && new URL(win.document.referrer).origin === win.location.origin;
  } catch {
    return false;
  }
}

/** The wall's pictures (`src/app/login/wall/`), picked from the top public posts on 2026-11-08 for the app. */
export const SIGN_IN_WALL_TILE_COUNT = 12;

/**
 * The pictures of the wall's column `column`, as indexes into the twelve, in the app's order
 * (`mediaWallColumn` in `ugc-mobile/components/media-wall.tsx`): every fourth from the column,
 * then every fourth from two on. Neighbouring columns never share a picture (the evens and the
 * odds alternate), and six of twelve per column means a picture never meets itself on screen.
 */
export function signInWallColumnOrder(column: number): number[] {
  return [0, 4, 8, 2, 6, 10].map((step) => (column + step) % SIGN_IN_WALL_TILE_COUNT);
}
