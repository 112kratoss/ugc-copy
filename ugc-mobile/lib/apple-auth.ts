import type { SupabaseClient } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';

type AppleAuthClient = Pick<SupabaseClient['auth'], 'signInWithIdToken' | 'updateUser'>;

type AppleFullName = {
  givenName?: string | null;
  middleName?: string | null;
  familyName?: string | null;
};

async function performNativeAppleAuthorization() {
  const rawNonce = `${Crypto.randomUUID()}${Crypto.randomUUID()}`.replace(/-/g, '');
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
  );

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    nonce: hashedNonce,
  });

  const identityToken = credential.identityToken;
  if (!identityToken) {
    throw new Error('Apple did not return an identity token.');
  }
  const authorizationCode = credential.authorizationCode;
  if (!authorizationCode) {
    throw new Error('Apple did not return an authorization code.');
  }

  return { authorizationCode, credential, identityToken, rawNonce };
}

async function requestNativeAppleCredential() {
  const isAvailable = await AppleAuthentication.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('Apple sign-in is not available on this device.');
  }

  try {
    return await performNativeAppleAuthorization();
  } catch (error) {
    // Account deletion revokes this app's Apple authorization server-side,
    // and the device's cached credential state learns that only by failing
    // the next fast-path attempt (or resolving without tokens). A single
    // fresh attempt runs the full consent flow and succeeds, so the person
    // sees the sheet again instead of an error banner. A cancel is a
    // decision, not a failure, and is never retried.
    if (isAppleAuthCanceled(error)) throw error;
    return await performNativeAppleAuthorization();
  }
}

function cleanNamePart(value: string | null | undefined) {
  return value?.trim() || null;
}

function getAppleProfileData(fullName: AppleFullName | null | undefined) {
  if (!fullName) {
    return null;
  }

  const givenName = cleanNamePart(fullName.givenName);
  const middleName = cleanNamePart(fullName.middleName);
  const familyName = cleanNamePart(fullName.familyName);
  const fullNameText = [givenName, middleName, familyName].filter(Boolean).join(' ');

  if (!fullNameText) {
    return null;
  }

  return {
    full_name: fullNameText,
    given_name: givenName,
    family_name: familyName,
  };
}

export function isAppleAuthCanceled(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_REQUEST_CANCELED'
  );
}

export async function signInWithNativeApple(supabase: { auth: AppleAuthClient }) {
  const { authorizationCode, credential, identityToken, rawNonce } = await requestNativeAppleCredential();

  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: identityToken,
    nonce: rawNonce,
  });

  if (error) {
    throw error;
  }

  const profileData = getAppleProfileData(credential.fullName);
  if (profileData) {
    const { error: updateError } = await supabase.auth.updateUser({ data: profileData });
    if (updateError) {
      console.warn('Failed to save Apple profile name', updateError);
    }
  }

  return {
    authorizationCode,
    appleUser: credential.user,
  };
}

export async function authorizeNativeAppleAccountDeletion() {
  const { authorizationCode, credential } = await requestNativeAppleCredential();

  // The backend exchanges this one-time code directly with Apple, validates
  // that Apple's subject belongs to the signed-in Supabase user, and revokes
  // the resulting Apple token before deleting the account. Keeping that proof
  // server-side avoids a redundant Supabase sign-in during account deletion.
  return {
    authorizationCode,
    appleUser: credential.user,
  };
}
