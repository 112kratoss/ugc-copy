import type { Session, User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('../lib/apple-auth', () => ({ authorizeNativeAppleAccountDeletion: vi.fn() }));
vi.mock('../lib/google-auth', () => ({ signInWithGoogleOAuth: vi.fn() }));

import {
  AccountReauthenticationAccountMismatchError,
  getAccountReauthenticationMethods,
  reauthenticateAccountForDeletion,
} from '../lib/account-reauthentication';

function user(id = 'user-1', providers = ['email']): User {
  return {
    id,
    email: 'creator@example.com',
    app_metadata: { provider: providers[0], providers },
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-07-20T12:00:00.000Z',
    identities: providers.map((provider) => ({
      id: `${provider}-identity`,
      identity_id: `${provider}-identity`,
      user_id: id,
      provider,
    })),
  };
}

function session(currentUser = user()): Session {
  return {
    access_token: 'fresh-access-token',
    refresh_token: 'fresh-refresh-token',
    expires_in: 3600,
    expires_at: 1_800_000_000,
    token_type: 'bearer',
    user: currentUser,
  };
}

function supabaseMock(nextSession = session()) {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: nextSession }, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: {}, error: null })),
    },
  };
}

describe('account deletion reauthentication', () => {
  it('verifies an existing email account with its current password', async () => {
    const currentUser = user();
    const supabase = supabaseMock(session(currentUser));

    await expect(reauthenticateAccountForDeletion({
      currentUser,
      method: { method: 'password', password: 'correct-password' },
      supabase: supabase as never,
    })).resolves.toEqual({ session: session(currentUser) });
    expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'creator@example.com',
      password: 'correct-password',
    });
  });

  it('runs Google OAuth and verifies it returned to the same Supabase account', async () => {
    const currentUser = user('user-1', ['google']);
    const supabase = supabaseMock(session(currentUser));
    const googleSignIn = vi.fn(async () => undefined);

    await expect(reauthenticateAccountForDeletion({
      currentUser,
      googleSignIn: googleSignIn as never,
      method: { method: 'google' },
      supabase: supabase as never,
    })).resolves.toEqual({ session: session(currentUser) });
    expect(googleSignIn).toHaveBeenCalledWith(supabase);
  });

  it('returns the one-time native Apple code only after same-account verification', async () => {
    const currentUser = user('user-1', ['apple']);
    const supabase = supabaseMock(session(currentUser));
    const appleAuthorize = vi.fn(async () => ({
      authorizationCode: 'one-time-apple-code',
      appleUser: 'apple-user-1',
    }));

    await expect(reauthenticateAccountForDeletion({
      appleAuthorize: appleAuthorize as never,
      currentUser,
      method: { method: 'apple' },
      platform: 'ios',
      supabase: supabase as never,
    })).resolves.toEqual({
      appleAuthorizationCode: 'one-time-apple-code',
    });
    expect(appleAuthorize).toHaveBeenCalledWith();
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
  });

  it('refuses deletion after any provider authenticates a different account', async () => {
    const currentUser = user('user-1', ['google']);
    const supabase = supabaseMock(session(user('user-2', ['google'])));

    await expect(reauthenticateAccountForDeletion({
      currentUser,
      googleSignIn: vi.fn(async () => undefined) as never,
      method: { method: 'google' },
      supabase: supabase as never,
    })).rejects.toBeInstanceOf(AccountReauthenticationAccountMismatchError);
  });

  it('requires Apple on iOS whenever Apple is one of several linked identities', () => {
    const linkedUser = user('user-1', ['email', 'apple']);

    expect(getAccountReauthenticationMethods(linkedUser, 'ios')).toEqual(['apple']);
    expect(getAccountReauthenticationMethods(linkedUser, 'android')).toEqual([]);
  });

  it('offers password and Google for non-Apple linked identities', () => {
    expect(getAccountReauthenticationMethods(
      user('user-1', ['email', 'google']),
      'android',
    )).toEqual(['password', 'google']);
  });
});
