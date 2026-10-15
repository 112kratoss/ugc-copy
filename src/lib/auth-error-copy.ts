/**
 * Plain wording for the failures Supabase reports during sign-in, sign-up
 * and password reset. The mobile app maps the same messages in
 * `ugc-mobile/lib/auth-error-copy.ts`; the web form showed the raw text
 * ("Invalid login credentials", "For security purposes, you can only request
 * this after 42 seconds"). Anything not recognised gets the caller's own
 * sentence: Supabase's text is written for a developer, and some of it (the
 * sign-up hook's refusal, the default mail sender's) names things this site
 * does not have.
 */
export function describeAuthError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = raw.toLowerCase();
  const code = errorCode(error);

  if (message.includes('failed to fetch') || message.includes('network request failed') || message.includes('load failed')) {
    return 'Could not reach the sign-in service. Check your connection and try again.';
  }
  if (message.includes('invalid login credentials') || message.includes('invalid_credentials')) {
    return 'That email and password do not match. Check both and try again, or use Google if you signed up with it.';
  }
  if (message.includes('email not confirmed')) {
    return 'Confirm your email first: open the confirmation link we sent when the account was created, then sign in.';
  }
  if (message.includes('user already registered') || message.includes('already been registered')) {
    return 'An account with this email already exists. Sign in instead, or reset the password.';
  }
  if (message.includes('too many requests') || message.includes('for security purposes') || message.includes('rate limit')) {
    return 'Too many attempts. Wait a minute before trying again.';
  }
  // The sign-up hook's own refusal also offers Apple, which this site lacks.
  if (message.includes('email sign-up is temporarily unavailable')) {
    return 'Email sign-up is temporarily unavailable. Continue with Google.';
  }
  if (code === 'same_password' || message.includes('should be different from the old password')) {
    return 'Choose a password different from your current one.';
  }
  return fallback;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : null;
}

/**
 * Whether a failed `getUser` check proves the session is over: Supabase Auth
 * refused the token (401/403), or said its session no longer exists, which
 * auth-js reports as `AuthSessionMissingError`. A network failure, a 5xx or a
 * rate limit says nothing about the session, so a signed-in page must not
 * conclude from one that the person signed out.
 */
export function isSessionRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, status } = error as { name?: unknown; status?: unknown };
  return status === 401 || status === 403 || name === 'AuthSessionMissingError';
}
