import type { SupabaseClient } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

type GoogleAuthClient = Pick<
  SupabaseClient['auth'],
  'exchangeCodeForSession' | 'signInWithOAuth'
>;

const GOOGLE_AUTH_CANCELED = 'ERR_GOOGLE_AUTH_CANCELED';

WebBrowser.maybeCompleteAuthSession();

export function getGoogleAuthRedirectUri() {
  return makeRedirectUri({
    scheme: 'magicbooklet',
    path: 'oauth/callback',
  });
}

export function isGoogleAuthCanceled(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === GOOGLE_AUTH_CANCELED,
  );
}

function canceledError() {
  return Object.assign(new Error('Google sign-in was canceled.'), {
    code: GOOGLE_AUTH_CANCELED,
  });
}

export async function signInWithGoogleOAuth(supabase: { auth: GoogleAuthClient }) {
  const redirectTo = getGoogleAuthRedirectUri();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
  });

  if (error) throw error;
  if (!data.url) throw new Error('Google sign-in could not be started.');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw canceledError();
  }
  if (result.type !== 'success' || !result.url) {
    throw new Error('Google sign-in did not return to Magicbooklet. Please try again.');
  }

  const callback = new URL(result.url);
  const providerError = callback.searchParams.get('error_description')
    ?? callback.searchParams.get('error');
  if (providerError) throw new Error(providerError);

  const code = callback.searchParams.get('code');
  if (!code) {
    throw new Error('Google sign-in returned without an authorization code.');
  }

  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) throw exchangeError;
}
