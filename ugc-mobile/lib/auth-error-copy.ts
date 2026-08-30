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
};

export const GENERIC_SIGN_IN_FAILURE: AuthNotice = {
  title: 'Could not sign you in',
  body: 'Something went wrong on our side. Try again in a moment.',
};

const OFFLINE: AuthNotice = {
  title: 'You appear to be offline',
  body: 'Check your connection, then try again.',
};

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
 * Compact rendering of whatever actually failed, for the temporary diagnostic
 * below. Reads the fields Supabase and expo-web-browser errors carry before
 * falling back to the message, and caps the length so a long provider string
 * cannot push the recovery sentence off screen.
 */
function describeProviderFailureCause(error: unknown): string {
  if (error && typeof error === 'object') {
    const parts: string[] = [];
    for (const key of ['code', 'status', 'name'] as const) {
      const value = (error as Record<string, unknown>)[key];
      if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${String(value)}`);
    }
    const message = 'message' in error ? String((error as { message: unknown }).message ?? '') : '';
    if (message) parts.push(message);
    if (parts.length > 0) return parts.join(' · ').slice(0, 240);
  }
  if (typeof error === 'string' && error) return error.slice(0, 240);
  return 'no error detail available';
}

/**
 * `provider` is the name the button already uses, so the recovery sentence
 * points at a control the person can see rather than at "the provider".
 *
 * TEMPORARY DIAGNOSTIC (added 2026-08-31, remove once the cause is known).
 * Google sign-in fails on the 0.1.2 Android alpha and this catch-all is what
 * hides why: five distinct client-side faults — no URL from signInWithOAuth, a
 * browser session that never returns, a provider error on the callback, a
 * callback with no code, and a failed code exchange — all render this one
 * sentence, and none of them is logged. The server chain verifies healthy end
 * to end (Supabase /authorize accepts the redirect, Google accepts the client),
 * so the fault is only observable on the device. Appending the cause is the
 * cheapest way to name it once. It contradicts this module's own rule about
 * never leaking raw strings, which is exactly why it must not outlive the fix.
 */
export function describeProviderSignInError(error: unknown, provider: 'Apple' | 'Google'): AuthNotice {
  if (isNetworkRequestFailedError(error)) return OFFLINE;

  return {
    title: `Could not finish with ${provider}`,
    body: `Try again, or sign in with your email and password. — Diagnostic: ${describeProviderFailureCause(error)}`,
  };
}
