import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { Platform } from 'react-native';

import { authorizeNativeAppleAccountDeletion } from './apple-auth';
import { signInWithGoogleOAuth } from './google-auth';

export type AccountReauthenticationMethod = 'password' | 'google' | 'apple';
export type AccountDeletionReauthentication =
  | { method: 'password'; password: string }
  | { method: 'google' }
  | { method: 'apple' };

export class AccountReauthenticationAccountMismatchError extends Error {
  constructor() {
    super('You signed in to a different account. Sign in to the account you want to delete.');
    this.name = 'AccountReauthenticationAccountMismatchError';
  }
}

export function getAccountReauthenticationMethods(
  user: User | null,
  platform = Platform.OS,
): AccountReauthenticationMethod[] {
  if (!user) return [];
  const identityProviders = (user.identities ?? [])
    .map((identity) => identity.provider)
    .filter((provider): provider is string => typeof provider === 'string');
  const metadataProviders = Array.isArray(user.app_metadata?.providers)
    ? user.app_metadata.providers.filter((provider): provider is string => typeof provider === 'string')
    : [];
  const primaryProvider = typeof user.app_metadata?.provider === 'string'
    ? [user.app_metadata.provider]
    : [];
  const providers = new Set<string>([
    ...identityProviders,
    ...metadataProviders,
    ...primaryProvider,
  ]);

  // Apple requires its own authorization code for token revocation, even when
  // another identity is linked to the same Magic Booklet account.
  if (providers.has('apple')) {
    return platform === 'ios' ? ['apple'] : [];
  }

  const methods: AccountReauthenticationMethod[] = [];
  if (providers.has('email') || (providers.size === 0 && user.email)) methods.push('password');
  if (providers.has('google')) methods.push('google');
  return methods;
}

export async function reauthenticateAccountForDeletion({
  appleAuthorize = authorizeNativeAppleAccountDeletion,
  currentUser,
  googleSignIn = signInWithGoogleOAuth,
  method,
  platform = Platform.OS,
  supabase,
}: {
  appleAuthorize?: typeof authorizeNativeAppleAccountDeletion;
  currentUser: User;
  googleSignIn?: typeof signInWithGoogleOAuth;
  method: AccountDeletionReauthentication;
  platform?: string;
  supabase: SupabaseClient;
}): Promise<{ session?: Session; appleAuthorizationCode?: string }> {
  if (method.method === 'password') {
    if (!currentUser.email) {
      throw new Error('This account does not have an email address for password verification.');
    }
    if (!method.password) {
      throw new Error('Enter your current password.');
    }
    const { error } = await supabase.auth.signInWithPassword({
      email: currentUser.email,
      password: method.password,
    });
    if (error) throw error;
  } else if (method.method === 'google') {
    await googleSignIn(supabase);
  } else {
    if (platform !== 'ios') {
      throw new Error('Continue with Apple on an iPhone or iPad to delete this account.');
    }
    const appleCredential = await appleAuthorize();
    return { appleAuthorizationCode: appleCredential.authorizationCode };
  }

  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const reauthenticatedSession = data.session;
  if (!reauthenticatedSession?.user) {
    throw new Error('Sign-in verification did not create a session. Please try again.');
  }
  if (reauthenticatedSession.user.id !== currentUser.id) {
    throw new AccountReauthenticationAccountMismatchError();
  }

  return { session: reauthenticatedSession };
}
