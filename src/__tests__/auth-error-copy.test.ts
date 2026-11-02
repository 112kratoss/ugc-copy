import { describe, expect, it } from 'vitest';

import { describeAuthError, isSessionRefusal } from '@/lib/auth-error-copy';

const FALLBACK = 'Could not sign in. Try again.';

function authError(message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name: 'AuthApiError', ...extra });
}

describe('describeAuthError', () => {
  it.each([
    ['Failed to fetch', 'Could not reach the sign-in service. Check your connection and try again.'],
    ['Invalid login credentials', 'That email and password do not match. Check both and try again. If you created the account with Google or Apple, use that button instead.'],
    ['Email not confirmed', 'Confirm your email first: open the confirmation link we sent when the account was created, then sign in.'],
    // D2: no reset email can be sent, so the sentence offers none.
    ['User already registered', 'An account with this email already exists. Sign in instead.'],
    ['For security purposes, you can only request this after 42 seconds.', 'Too many attempts. Wait a minute before trying again.'],
  ])('keeps the plain wording for "%s"', (raw, shown) => {
    expect(describeAuthError(authError(raw), FALLBACK)).toBe(shown);
  });

  it('says what to do about a reused password', () => {
    expect(describeAuthError(authError('New password should be different from the old password.', { status: 422, code: 'same_password' }), FALLBACK))
      .toBe('Choose a password different from your current one.');
  });

  // Audit 01-9: the fallback printed whatever Supabase said.
  it.each([
    authError('Error sending confirmation email', { status: 500 }),
    authError('Signups not allowed for this instance', { status: 422 }),
    // The sign-up hook's refusal: the web makes no email sign-up that could meet it.
    authError('Email sign-up is temporarily unavailable. Continue with Google or Apple.', { status: 403 }),
    'Database error saving new user',
    { message: 'Unexpected failure, please check server logs for more information' },
    null,
  ])('uses the caller\'s own sentence for anything it does not recognise (%#)', (error) => {
    expect(describeAuthError(error, FALLBACK)).toBe(FALLBACK);
  });
});

describe('isSessionRefusal', () => {
  it.each([
    ['a refused token', { name: 'AuthApiError', status: 403, code: 'bad_jwt' }],
    ['a missing authorization', { name: 'AuthApiError', status: 401, code: 'no_authorization' }],
    ['an account Supabase no longer has', { name: 'AuthApiError', status: 403, code: 'user_not_found' }],
    ['a session Supabase no longer has', Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400 })],
  ])('is true for %s', (_label, error) => {
    expect(isSessionRefusal(error)).toBe(true);
  });

  it.each([
    ['a failed connection', Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 })],
    ['a 503', { name: 'AuthRetryableFetchError', status: 503 }],
    ['a rate limit', { name: 'AuthApiError', status: 429, code: 'over_request_rate_limit' }],
    ['an unreadable answer', { name: 'AuthUnknownError', message: 'Unexpected token <' }],
    ['a thrown error without a status', new Error('boom')],
    ['nothing', null],
  ])('is false for %s', (_label, error) => {
    expect(isSessionRefusal(error)).toBe(false);
  });
});
