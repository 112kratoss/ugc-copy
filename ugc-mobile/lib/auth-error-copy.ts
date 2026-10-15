import { isNetworkRequestFailedError } from './supabase-auth-recovery';

/**
 * The words the auth screen says when something goes wrong.
 *
 * Supabase's own messages are written for the developer reading a log
 * ("Invalid login credentials"), and the screen used to print them verbatim.
 * HIG Feedback asks the opposite: "show people when a command can't be carried
 * out and help them understand why", and every entry here therefore names the
 * problem in the app's voice and says what to do next. Anything unrecognised
 * falls back to `GENERIC_SIGN_IN_FAILURE` rather than leaking the raw string —
 * the same rule S12 and S13 applied to post and profile load failures.
 */
export type AuthNotice = {
  title: string;
  body: string;
  /**
   * Omitted for the failures that make up almost every notice on this screen.
   * Set to 'info' only when the notice explains a redirect rather than
   * reporting that something went wrong.
   */
  tone?: 'danger' | 'info';
};

export const GENERIC_SIGN_IN_FAILURE: AuthNotice = {
  title: 'Could not sign you in',
  body: 'Something went wrong on our side. Try again in a moment.',
};

export const OFFLINE: AuthNotice = {
  title: 'You appear to be offline',
  body: 'Check your connection, then try again.',
};

/**
 * Shown when this device arrives at sign-in because its guest session was
 * linked to an account (409 SESSION_MERGED), not because anything failed.
 *
 * The wording avoids "error" and "expired" on purpose. Nothing broke and the
 * work is not lost — it moved to the account — so the message names the cause
 * and the one action that resolves it.
 */
export const GUEST_SESSION_MERGED: AuthNotice = {
  title: 'Sign in to pick up where you left off',
  body: 'This device was browsing as a guest, and that guest was added to an account. Sign in and your credits and creations come with you.',
  tone: 'info',
};

/**
 * Shown when this device arrives at sign-in because the server refused its
 * session: it ended somewhere else.
 *
 * Informational, like GUEST_SESSION_MERGED. It names no cause and promises
 * nothing about the account: a sign-out elsewhere, a password change and a
 * deletion started on another device all end the session the same way, and
 * telling someone whose account is being erased that nothing is wrong would be
 * the one false thing this notice could say (audit 04-1).
 */
export const SESSION_ENDED_ELSEWHERE: AuthNotice = {
  title: 'You were signed out',
  body: 'Your session on this device ended. Sign in again to continue.',
  tone: 'info',
};

/**
 * The `code` on the error a guest's sign-in throws when the ticket that carries
 * its credits to the account could not be prepared. The sign-in stops before
 * it replaces the guest session, so nothing has been lost.
 */
export const GUEST_MERGE_PREPARE_ERROR_CODE = 'guest_merge_prepare';

/**
 * Informational: nothing on the device failed for good, and the one sentence
 * that matters to a guest who bought credits is that they are still here.
 */
export const GUEST_MERGE_PREPARE_FAILED: AuthNotice = {
  title: 'Sign-in paused',
  body: 'We could not prepare your guest credits for transfer, so we stopped before switching accounts. Your credits are safe on this device. Check your connection and try again.',
  tone: 'info',
};

const REDIRECT_NOTICES = new Map<string, AuthNotice>([
  ['session-merged', GUEST_SESSION_MERGED],
  ['signed-out', SESSION_ENDED_ELSEWHERE],
]);

/**
 * The notice a redirect asked the sign-in screen to show, from its `notice`
 * route parameter. Only a known key maps to copy; anything else shows nothing,
 * so a deep link cannot put its own text on the sign-in screen.
 */
export function authNoticeForRedirect(key: string | string[] | undefined): AuthNotice | null {
  const value = Array.isArray(key) ? key[0] : key;
  return value ? REDIRECT_NOTICES.get(value) ?? null : null;
}

/** Client-side checks, so a typo costs a glance rather than a round trip. */
export const INVALID_EMAIL: AuthNotice = {
  title: 'Check the email address',
  body: 'Enter it in full, as name@example.com.',
};

export const PASSWORD_TOO_SHORT: AuthNotice = {
  title: 'Password is too short',
  body: 'Passwords are at least 8 characters with a number, a symbol, upper and lower case.',
};

/**
 * Deliberately permissive: this catches the typo the server would bounce
 * ("nobody2example"), not every address RFC 5322 allows. A real address the
 * pattern rejects would be a worse failure than a fake one it lets through, so
 * it asks only for `local@domain.tld` with no spaces.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The hint names the current policy (8 characters, four kinds), but the check
 * stays at the old floor of 6: Supabase applies the policy when a password is
 * set, not at sign-in, so a legacy account made under the old floor still signs
 * in, and the phone must not stop it before the server has seen its password.
 */
export const MIN_PASSWORD_LENGTH = 6;

export function isPlausibleEmail(value: string) {
  return EMAIL_PATTERN.test(value.trim());
}

/** Returns the notice to show, or null when the credentials pass the local checks. */
export function validateCredentials(email: string, password: string): AuthNotice | null {
  if (!isPlausibleEmail(email)) return INVALID_EMAIL;
  if (password.length < MIN_PASSWORD_LENGTH) return PASSWORD_TOO_SHORT;
  return null;
}

function messageOf(error: unknown) {
  return (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
}

function isGuestMergePrepareFailure(error: unknown) {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === GUEST_MERGE_PREPARE_ERROR_CODE;
}

export type SignInProvider = 'Apple' | 'Google';

/**
 * The provider buttons the sign-in screen draws on `platform`: Apple on iOS,
 * Google on Android. Copy names only these, since advice to "use that button"
 * is worthless where the button is not drawn (audit 01-8).
 */
export function signInProviderButtons(platform: string): SignInProvider[] {
  if (platform === 'ios') return ['Apple'];
  if (platform === 'android') return ['Google'];
  return [];
}

export type PasswordSignInCopyContext = {
  /** The provider buttons drawn beside the password field. */
  providerButtons?: readonly SignInProvider[];
  /**
   * False where only the password is typed, as on the deletion screen, which
   * checks the account's own address.
   */
  asksForEmail?: boolean;
};

export function describePasswordSignInError(
  error: unknown,
  { providerButtons = [], asksForEmail = true }: PasswordSignInCopyContext = {},
): AuthNotice {
  if (isGuestMergePrepareFailure(error)) return GUEST_MERGE_PREPARE_FAILED;
  if (isNetworkRequestFailedError(error)) return OFFLINE;

  const message = messageOf(error);

  if (message.includes('invalid login credentials') || message.includes('invalid_credentials')) {
    const otherWay = providerButtons.length > 0
      ? ` If you created the account with ${providerButtons.join(' or ')}, use that button instead.`
      : '';
    return asksForEmail
      ? { title: 'That email and password do not match', body: `Check both and try again.${otherWay}` }
      : { title: 'That password does not match this account', body: `Check it and try again.${otherWay}` };
  }

  if (message.includes('email not confirmed')) {
    return {
      title: 'Confirm your email first',
      body: 'Open the confirmation link we sent when the account was created, then sign in.',
    };
  }

  if (message.includes('too many requests') || message.includes('for security purposes') || message.includes('rate limit')) {
    return {
      title: 'Too many attempts',
      body: 'Wait a minute before trying again.',
    };
  }

  return GENERIC_SIGN_IN_FAILURE;
}

/**
 * `provider` is the name the button already uses, so the recovery sentence
 * points at a control the person can see rather than at "the provider".
 *
 * The password is offered only for an account known to have one
 * (`passwordAvailable`). Accounts have been made with Apple or Google alone
 * since July, so on the sign-in screen, where the account is not known yet,
 * that advice would be wrong for nearly everyone (audit 01-8).
 */
export function describeProviderSignInError(
  error: unknown,
  provider: SignInProvider,
  { passwordAvailable = false }: { passwordAvailable?: boolean } = {},
): AuthNotice {
  if (isGuestMergePrepareFailure(error)) return GUEST_MERGE_PREPARE_FAILED;
  if (isNetworkRequestFailedError(error)) return OFFLINE;

  return {
    title: `Could not finish with ${provider}`,
    body: passwordAvailable ? 'Try again, or sign in with your email and password.' : 'Try again.',
  };
}
