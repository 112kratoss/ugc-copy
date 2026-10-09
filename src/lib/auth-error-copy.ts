/**
 * Plain wording for the failures Supabase reports during sign-in, sign-up
 * and password reset. The mobile app maps the same messages in
 * `ugc-mobile/lib/auth-error-copy.ts`; the web form showed the raw text
 * ("Invalid login credentials", "For security purposes, you can only request
 * this after 42 seconds").
 */
export function describeAuthError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const message = raw.toLowerCase();

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
  return raw || fallback;
}
