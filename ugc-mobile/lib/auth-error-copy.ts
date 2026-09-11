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

const OFFLINE: AuthNotice = {
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
 * session: it ended somewhere else, most often when the account signed out on
 * another device.
 *
 * Informational, like GUEST_SESSION_MERGED. Nothing failed here and nothing on
 * the account was lost. It names the usual cause without claiming to be sure of
 * it, since a removed session or a password change end it the same way, and
 * points at the one action that resolves it.
 */
export const SESSION_ENDED_ELSEWHERE: AuthNotice = {
  title: 'You were signed out',
  body: 'Your session on this device ended, usually because the account signed out somewhere else. Sign in again to pick up where you left off.',
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
  body: 'Passwords are at least 6 characters.',
};

/**
 * Deliberately permissive: this catches the typo the server would bounce
 * ("nobody2example"), not every address RFC 5322 allows. A real address the
 * pattern rejects would be a worse failure than a fake one it lets through, so
 * it asks only for `local@domain.tld` with no spaces.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

export function describePasswordSignInError(error: unknown): AuthNotice {
  if (isNetworkRequestFailedError(error)) return OFFLINE;

  const message = messageOf(error);

  if (message.includes('invalid login credentials') || message.includes('invalid_credentials')) {
    return {
      title: 'That email and password do not match',
      body: 'Check both and try again. If you created the account with Apple or Google, use that button instead.',
    };
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
 */
export function describeProviderSignInError(error: unknown, provider: 'Apple' | 'Google'): AuthNotice {
  if (isNetworkRequestFailedError(error)) return OFFLINE;

  return {
    title: `Could not finish with ${provider}`,
    body: 'Try again, or sign in with your email and password.',
  };
}
