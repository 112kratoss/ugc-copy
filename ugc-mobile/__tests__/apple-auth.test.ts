import { beforeEach, describe, expect, it, vi } from 'vitest';

const appleAuth = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  signInAsync: vi.fn(),
  AppleAuthenticationScope: {
    FULL_NAME: 'FULL_NAME',
    EMAIL: 'EMAIL',
  },
}));

vi.mock('expo-apple-authentication', () => appleAuth);

import {
  isAppleAuthCanceled,
  signInWithNativeApple,
} from '../lib/apple-auth';

function createSupabaseMock() {
  return {
    auth: {
      signInWithIdToken: vi.fn(),
      updateUser: vi.fn(),
    },
  };
}

describe('native Apple auth', () => {
  beforeEach(() => {
    appleAuth.isAvailableAsync.mockReset();
    appleAuth.signInAsync.mockReset();
    appleAuth.isAvailableAsync.mockResolvedValue(true);
    appleAuth.signInAsync.mockResolvedValue({
      identityToken: 'apple-id-token',
      authorizationCode: 'apple-authorization-code',
      fullName: {
        givenName: 'Ada',
        middleName: null,
        familyName: 'Lovelace',
      },
    });
  });

  it('signs into Supabase with the native Apple identity token and authorization code', async () => {
    const supabase = createSupabaseMock();
    supabase.auth.signInWithIdToken.mockResolvedValue({ data: {}, error: null });
    supabase.auth.updateUser.mockResolvedValue({ data: {}, error: null });

    await signInWithNativeApple(supabase as never);

    expect(appleAuth.signInAsync).toHaveBeenCalledWith({
      requestedScopes: ['FULL_NAME', 'EMAIL'],
    });
    expect(supabase.auth.signInWithIdToken).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'apple-id-token',
      access_token: 'apple-authorization-code',
    });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({
      data: {
        full_name: 'Ada Lovelace',
        given_name: 'Ada',
        family_name: 'Lovelace',
      },
    });
  });

  it('fails before Supabase sign-in when Apple does not return an identity token', async () => {
    const supabase = createSupabaseMock();
    appleAuth.signInAsync.mockResolvedValue({
      identityToken: null,
      authorizationCode: 'apple-authorization-code',
      fullName: null,
    });

    await expect(signInWithNativeApple(supabase as never)).rejects.toThrow(
      'Apple did not return an identity token.'
    );
    expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled();
  });

  it('reports unavailable Apple auth before starting the native flow', async () => {
    const supabase = createSupabaseMock();
    appleAuth.isAvailableAsync.mockResolvedValue(false);

    await expect(signInWithNativeApple(supabase as never)).rejects.toThrow(
      'Apple sign-in is not available on this device.'
    );
    expect(appleAuth.signInAsync).not.toHaveBeenCalled();
  });

  it('recognizes native Apple auth cancellation errors', () => {
    expect(isAppleAuthCanceled({ code: 'ERR_REQUEST_CANCELED' })).toBe(true);
    expect(isAppleAuthCanceled(new Error('Different failure'))).toBe(false);
  });
});
