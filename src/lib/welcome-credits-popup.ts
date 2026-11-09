import { CREATOR_PAGE_PATHS } from '@/lib/creator-pages';
import { REFERRAL_CLAIM_REASON_PATTERN, REFERRAL_CLAIM_STATUS_PARAM } from '@/lib/referral-claim-copy';

import { welcomeFillProgress } from '../../ugc-mobile/lib/welcome-popup-policy/welcome-popup-policy';

/**
 * Where and how often the web's welcome-credits popup is offered (owner,
 * 2026-11-09: the app's popup on the web, "all the design and functionalities
 * also"; it shows on Home, on the creators, and on the page a sign-up returns
 * to). Who it is offered to, and the fill, are the app's own rules
 * (`ugc-mobile/lib/welcome-popup-policy/`); this module holds what only the
 * web has: addresses, the browser session, the browser's storage.
 *
 * Imported by the root layout's deferred mount, so it stays small: no
 * Supabase, no React.
 */

/** The query flag on the page a sign-up returned to (`withCreatorWelcome` in `auth-onboarding.ts`). */
export const WELCOME_RETURN_PARAM = 'welcome';

/** Home (`/`, served from `/home` for an account) and the creators always offer it. */
const OFFERING_PATHS: ReadonlySet<string> = new Set(['/', '/home', '/create', ...CREATOR_PAGE_PATHS]);
const CREATOR_PATHS: ReadonlySet<string> = new Set(CREATOR_PAGE_PATHS);

/**
 * Pages it never covers, whatever their address says: signing in and its
 * screens, the name step a sign-up passes first, the checkout, the operator
 * console, and the old welcome page's redirect.
 */
const NEVER_OVER = ['/login', '/auth', '/onboarding', '/pricing', '/admin', '/welcome-reward'];

export function isNeverUnderWelcomePopup(pathname: string): boolean {
  return NEVER_OVER.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** The page a sign-up came back to, and the invite's outcome it brought (`referral`). */
export type WelcomeReturn = { pathname: string; referral: string | null };

/**
 * The flags a return from sign-up put on this address, read once: the page is
 * remembered as the one returned to, and the address loses them, so a reload
 * or a shared link does not greet the account again. The creators read their
 * own (their welcome card draws from the server's copy and drops the flags
 * itself), and a page the popup never covers keeps its address as it is.
 */
export function readWelcomeReturn(pathname: string, search: string): { referral: string | null; search: string } | null {
  if (isNeverUnderWelcomePopup(pathname) || CREATOR_PATHS.has(pathname)) return null;
  const params = new URLSearchParams(search);
  if (params.get(WELCOME_RETURN_PARAM) !== '1') return null;
  const referral = params.get(REFERRAL_CLAIM_STATUS_PARAM);
  params.delete(WELCOME_RETURN_PARAM);
  params.delete(REFERRAL_CLAIM_STATUS_PARAM);
  const rest = params.toString();
  return {
    referral: referral && REFERRAL_CLAIM_REASON_PATTERN.test(referral) ? referral : null,
    search: rest ? `?${rest}` : '',
  };
}

/** Whether the page in front offers the popup: Home, a creator, or the page a sign-up returned to. */
export function isWelcomePopupOfferedAt(pathname: string, returnedTo: string | null): boolean {
  if (isNeverUnderWelcomePopup(pathname)) return false;
  return OFFERING_PATHS.has(pathname) || returnedTo === pathname;
}

/**
 * One frame of the fill: the ring follows the shared curve, and the figure
 * follows it too but never moves more than one credit a frame, so every
 * credit is seen however slowly the frames come (a busy or background tab).
 * Done once the curve has run out and the figure has reached the amount.
 */
export function nextWelcomeFill({ elapsed, amount, shown }: { elapsed: number; amount: number; shown: number }) {
  const fill = welcomeFillProgress(elapsed);
  const target = Math.floor(amount * fill);
  const count = Math.max(shown, Math.min(target, shown + 1, amount));
  return { fill, count, done: fill >= 1 && count >= amount };
}

/**
 * The card's entrance, the app's own spring (`appTheme.motion.spring`, tension
 * 190 and friction 13, which React Native turns into stiffness 773 and damping
 * 40 for a mass of 1): sampled every 1/60 s until it rests, as keyframes the
 * Web Animations API joins linearly. Its progress runs 0 to 1, overshooting by
 * about four hundredths before it settles.
 */
export function welcomeEntrySpring({ tension = 190, friction = 13 } = {}) {
  const stiffness = (tension - 30) * 3.62 + 194;
  const damping = (friction - 8) * 3 + 25;
  const omega = Math.sqrt(stiffness);
  const zeta = damping / (2 * omega);
  const omegaD = omega * Math.sqrt(Math.max(0, 1 - zeta * zeta));
  const at = (t: number) => 1 - Math.exp(-zeta * omega * t) * (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t));
  // At rest once the swing is under a thousandth, as React Native's spring rests.
  const restAt = Math.log(1000) / (zeta * omega);
  const frames = Math.ceil(restAt * 60);
  const progress = Array.from({ length: frames + 1 }, (_, frame) => (frame === frames ? 1 : at(frame / 60)));
  return { durationMs: Math.round((frames / 60) * 1000), progress };
}

/*
 * A close lasts a while, per account, as the app's lasts until the next start:
 * kept in a cookie every tab of the browser shares, for six hours at most. Not a
 * session cookie: a browser that restores its session keeps those for good, and
 * the popup is where the web claims the welcome credits. Where cookies are
 * refused, a close holds for this page instead.
 */
export const WELCOME_POPUP_CLOSED_COOKIE = 'mb_welcome_popup_closed';
const ACCOUNT_ID = /^[0-9a-f-]{8,64}$/i;
const MAX_CLOSED_ACCOUNTS = 4;
const CLOSED_FOR_SECONDS = 6 * 60 * 60;
const closedThisPage = new Set<string>();

function closedAccountsInCookie(): string[] {
  if (typeof document === 'undefined') return [];
  const entry = document.cookie.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${WELCOME_POPUP_CLOSED_COOKIE}=`));
  if (!entry) return [];
  return decodeURIComponent(entry.slice(WELCOME_POPUP_CLOSED_COOKIE.length + 1))
    .split('.')
    .filter((id) => ACCOUNT_ID.test(id));
}

export function wasWelcomePopupClosedThisSession(userId: string): boolean {
  return closedThisPage.has(userId) || closedAccountsInCookie().includes(userId);
}

export function rememberWelcomePopupClosed(userId: string) {
  closedThisPage.add(userId);
  if (typeof document === 'undefined' || !ACCOUNT_ID.test(userId)) return;
  const accounts = [...closedAccountsInCookie().filter((id) => id !== userId), userId].slice(-MAX_CLOSED_ACCOUNTS);
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  try {
    document.cookie = `${WELCOME_POPUP_CLOSED_COOKIE}=${accounts.join('.')}; Max-Age=${CLOSED_FOR_SECONDS}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Refused: the close holds for this page.
  }
}

/** For tests: a new browser session. */
export function resetWelcomePopupSession() {
  closedThisPage.clear();
  if (typeof document !== 'undefined') document.cookie = `${WELCOME_POPUP_CLOSED_COOKIE}=; Max-Age=0; Path=/`;
}

/*
 * An account whose credits can never be offered again (claimed, by it or by
 * another account of the same person) is remembered in this browser for a
 * week, so a visit to Home or a creator does not ask the server each time.
 * The key is the one Home's welcome card wrote, so a browser that already
 * knows stays quiet.
 */
const SETTLED_KEY_PREFIX = 'magicbooklet:welcome-settled:v1:';
const SETTLED_FOR_MS = 7 * 24 * 60 * 60 * 1_000;
const SETTLED_STATUSES: ReadonlySet<string> = new Set(['claimed', 'already_claimed', 'identity_already_claimed']);

export function isWelcomeAnswerSettled(status: string | null | undefined): boolean {
  return typeof status === 'string' && SETTLED_STATUSES.has(status);
}

export function isWelcomeSettledHere(userId: string): boolean {
  try {
    const at = Number(window.localStorage.getItem(`${SETTLED_KEY_PREFIX}${userId}`));
    const age = Date.now() - at;
    return at > 0 && age >= 0 && age < SETTLED_FOR_MS;
  } catch {
    return false;
  }
}

export function rememberWelcomeSettled(userId: string) {
  try {
    window.localStorage.setItem(`${SETTLED_KEY_PREFIX}${userId}`, String(Date.now()));
  } catch {
    // Blocked storage: the next visit asks, as it always did.
  }
}

/**
 * Told when an account's offer may have changed without a new page: a creator
 * name saved on a creator's welcome card makes its credits claimable.
 */
export const WELCOME_OFFER_CHANGED_EVENT = 'magicbooklet:welcome-offer-changed';

export function announceWelcomeOfferChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(WELCOME_OFFER_CHANGED_EVENT));
}
