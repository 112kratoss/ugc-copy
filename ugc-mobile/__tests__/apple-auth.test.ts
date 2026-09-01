import { beforeEach, describe, expect, it, vi } from 'vitest';

const appleAuth = vi.hoisted(() => ({
  isAvailableAsync: vi.fn(),
  signInAsync: vi.fn(),
  AppleAuthenticationScope: {
    FULL_NAME: 'FULL_NAME',
    EMAIL: 'EMAIL',
  },
}));

const cryptoMock = vi.hoisted(() => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock('expo-apple-authentication', () => appleAuth);
vi.mock('expo-crypto', () => cryptoMock);

import {
  authorizeNativeAppleAccountDeletion,
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
    cryptoMock.randomUUID
      .mockReset()
      .mockReturnValueOnce('11111111-1111-1111-1111-111111111111')
      .mockReturnValueOnce('22222222-2222-2222-2222-222222222222');
    cryptoMock.digestStringAsync.mockReset();
    cryptoMock.digestStringAsync.mockResolvedValue('hashed-apple-nonce');
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

  it('signs into Supabase with the native Apple identity token and verified nonce', async () => {
    const supabase = createSupabaseMock();
    supabase.auth.signInWithIdToken.mockResolvedValue({ data: {}, error: null });
    supabase.auth.updateUser.mockResolvedValue({ data: {}, error: null });

    await expect(signInWithNativeApple(supabase as never)).resolves.toEqual({
      authorizationCode: 'apple-authorization-code',
      appleUser: undefined,
    });

    expect(appleAuth.signInAsync).toHaveBeenCalledWith({
      requestedScopes: ['FULL_NAME', 'EMAIL'],
      nonce: 'hashed-apple-nonce',
    });
    expect(supabase.auth.signInWithIdToken).toHaveBeenCalledWith({
      provider: 'apple',
      token: 'apple-id-token',
      nonce: '1111111111111111111111111111111122222222222222222222222222222222',
    });
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({
      data: {
        full_name: 'Ada Lovelace',
        given_name: 'Ada',
        family_name: 'Lovelace',
      },
    });
  });

  it('returns a one-time deletion code without another Supabase sign-in', async () => {
    await expect(authorizeNativeAppleAccountDeletion()).resolves.toEqual({
      authorizationCode: 'apple-authorization-code',
      appleUser: undefined,
    });

    expect(appleAuth.signInAsync).toHaveBeenCalledWith({
      requestedScopes: ['FULL_NAME', 'EMAIL'],
      nonce: 'hashed-apple-nonce',
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

  it('fails before Supabase sign-in when Apple does not return an authorization code', async () => {
    const supabase = createSupabaseMock();
    appleAuth.signInAsync.mockResolvedValue({
      identityToken: 'apple-id-token',
      authorizationCode: null,
      fullName: null,
    });

    await expect(signInWithNativeApple(supabase as never)).rejects.toThrow(
      'Apple did not return an authorization code.'
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

  it('retries the native sheet once when the first attempt fails', async () => {
    // Deleting an account revokes the Apple authorization server-side; the
    // device's cached credential state fails the next fast-path attempt once
    // before iOS refreshes it, and the fresh attempt succeeds.
    const supabase = createSupabaseMock();
    supabase.auth.signInWithIdToken.mockResolvedValue({ data: {}, error: null });
    supabase.auth.updateUser.mockResolvedValue({ data: {}, error: null });
    cryptoMock.randomUUID.mockReset().mockReturnValue('33333333-3333-3333-3333-333333333333');
    appleAuth.signInAsync
      .mockRejectedValueOnce({ code: 'ERR_REQUEST_UNKNOWN' })
      .mockResolvedValueOnce({
        identityToken: 'apple-id-token',
        authorizationCode: 'apple-authorization-code',
        fullName: null,
      });

    await expect(signInWithNativeApple(supabase as never)).resolves.toEqual({
      authorizationCode: 'apple-authorization-code',
      appleUser: undefined,
    });
    expect(appleAuth.signInAsync).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first attempt resolves without an identity token', async () => {
    const supabase = createSupabaseMock();
    supabase.auth.signInWithIdToken.mockResolvedValue({ data: {}, error: null });
    supabase.auth.updateUser.mockResolvedValue({ data: {}, error: null });
    cryptoMock.randomUUID.mockReset().mockReturnValue('33333333-3333-3333-3333-333333333333');
    appleAuth.signInAsync
      .mockResolvedValueOnce({
        identityToken: null,
        authorizationCode: null,
        fullName: null,
      })
      .mockResolvedValueOnce({
        identityToken: 'apple-id-token',
        authorizationCode: 'apple-authorization-code',
        fullName: null,
      });

    await expect(signInWithNativeApple(supabase as never)).resolves.toEqual({
      authorizationCode: 'apple-authorization-code',
      appleUser: undefined,
    });
    expect(appleAuth.signInAsync).toHaveBeenCalledTimes(2);
  });

  it('never retries when the person cancels the Apple sheet', async () => {
    const supabase = createSupabaseMock();
    appleAuth.signInAsync.mockRejectedValue({ code: 'ERR_REQUEST_CANCELED' });

    await expect(signInWithNativeApple(supabase as never)).rejects.toMatchObject({
      code: 'ERR_REQUEST_CANCELED',
    });
    expect(appleAuth.signInAsync).toHaveBeenCalledTimes(1);
    expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled();
  });

  it('surfaces the failure when the retry also fails', async () => {
    const supabase = createSupabaseMock();
    cryptoMock.randomUUID.mockReset().mockReturnValue('33333333-3333-3333-3333-333333333333');
    appleAuth.signInAsync.mockRejectedValue({ code: 'ERR_REQUEST_UNKNOWN' });

    await expect(signInWithNativeApple(supabase as never)).rejects.toMatchObject({
      code: 'ERR_REQUEST_UNKNOWN',
    });
    expect(appleAuth.signInAsync).toHaveBeenCalledTimes(2);
    expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled();
  });
});
