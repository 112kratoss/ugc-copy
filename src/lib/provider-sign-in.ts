import { describeAuthError } from '@/lib/auth-error-copy';
import { getAuthCallbackUrl } from '@/lib/auth-callback-url';
import { supabase } from '@/lib/supabase';

/**
 * The providers the website signs in with: the login page's two tabs and the
 * creators' sign-up sheet draw a button for each, Google first. Apple is
 * Supabase's web flow through the website's Services ID (the runbook's "Sign
 * in with Apple on the web").
 */
export type SignInProvider = 'google' | 'apple';

export const SIGN_IN_PROVIDER_NAMES: Record<SignInProvider, string> = { google: 'Google', apple: 'Apple' };

/**
 * Leaves for the provider, which comes back through /auth/callback and on to
 * `nextPath`. auth-js only builds the address and navigates, so a provider that
 * is off or misconfigured shows its own error page and comes back without a
 * code; what resolves here is the sentence for a start that failed in this
 * browser, or null once the page is leaving.
 */
export async function startProviderSignIn(provider: SignInProvider, nextPath: string): Promise<string | null> {
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: getAuthCallbackUrl(nextPath) },
    });
    if (error) throw error;
    return null;
  } catch (error: unknown) {
    return describeAuthError(error, `Could not start ${SIGN_IN_PROVIDER_NAMES[provider]} sign-in. Try again.`);
  }
}
