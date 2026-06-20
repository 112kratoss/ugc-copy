import type { SupabaseClient } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';

type AppleAuthClient = Pick<SupabaseClient['auth'], 'signInWithIdToken' | 'updateUser'>;

type AppleFullName = {
  givenName?: string | null;
  middleName?: string | null;
  familyName?: string | null;
};

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
  const isAvailable = await AppleAuthentication.isAvailableAsync();
  if (!isAvailable) {
    throw new Error('Apple sign-in is not available on this device.');
  }

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  if (!credential.identityToken) {
    throw new Error('Apple did not return an identity token.');
  }

  const { error } = await supabase.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    access_token: credential.authorizationCode ?? undefined,
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
}
