import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
} from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isInvalidRefreshTokenError,
  isNetworkRequestFailedError,
  isSessionEndedRefreshError,
  supabaseNetworkFailureMessage,
  withSuppressedInvalidRefreshTokenConsoleError,
} from '../lib/supabase-auth-recovery';

describe('isSessionEndedRefreshError', () => {
  // The same line auth-js draws before it deletes a stored session: every auth
  // error except a retryable fetch failure. Checked against the real classes so
  // a library upgrade that renames them fails here, not on a phone.
  it('treats a refused refresh token as a session that has ended', () => {
    expect(isSessionEndedRefreshError(
      new AuthApiError('Invalid Refresh Token: Refresh Token Not Found', 400, 'refresh_token_not_found'),
    )).toBe(true);
    expect(isSessionEndedRefreshError(
      new AuthApiError('Invalid Refresh Token: Already Used', 400, 'refresh_token_already_used'),
    )).toBe(true);
    expect(isSessionEndedRefreshError(new AuthApiError('Session Expired', 403, 'session_expired'))).toBe(true);
    expect(isSessionEndedRefreshError(new AuthSessionMissingError())).toBe(true);
  });

  it('keeps the session through network failures and server errors, which auth-js retries', () => {
    expect(isSessionEndedRefreshError(new AuthRetryableFetchError('Network request failed', 0))).toBe(false);
    expect(isSessionEndedRefreshError(new AuthRetryableFetchError('Service Unavailable', 503))).toBe(false);
  });

  it('ignores anything that is not an auth error, and a refresh that succeeded', () => {
    expect(isSessionEndedRefreshError(null)).toBe(false);
    expect(isSessionEndedRefreshError(undefined)).toBe(false);
    expect(isSessionEndedRefreshError(new Error('Invalid Refresh Token: Refresh Token Not Found'))).toBe(false);
    expect(isSessionEndedRefreshError({ message: 'Unauthorized', status: 401 })).toBe(false);
  });

  it('follows auth-js for an unparseable refusal, which it has already signed out locally', () => {
    // AuthUnknownError is a non-5xx response auth-js could not read. It is not
    // retryable, so auth-js has deleted the stored session by the time the
    // refresh returns; the app finishes the same teardown rather than keep a
    // signed-in screen over a session that is already gone.
    expect(isSessionEndedRefreshError(new AuthUnknownError('Unexpected token <', null))).toBe(true);
  });
});

describe('isInvalidRefreshTokenError', () => {
  it('recognizes stale Supabase refresh-token errors', () => {
    expect(isInvalidRefreshTokenError(new Error('Invalid Refresh Token: Already Used'))).toBe(true);
    expect(isInvalidRefreshTokenError({ message: 'Invalid Refresh Token: Refresh Token Not Found' })).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isInvalidRefreshTokenError(new Error('Network request failed'))).toBe(false);
    expect(isInvalidRefreshTokenError('Invalid login credentials')).toBe(false);
  });
});

describe('Supabase network errors', () => {
  it('recognizes React Native fetch network failures', () => {
    expect(isNetworkRequestFailedError(new TypeError('Network request failed'))).toBe(true);
    expect(isNetworkRequestFailedError(new Error('Invalid login credentials'))).toBe(false);
  });

  it('explains local Supabase failures with the configured root', () => {
    expect(supabaseNetworkFailureMessage('http://10.0.2.2:54321')).toContain(
      'Could not reach local Supabase at http://10.0.2.2:54321'
    );
  });
});

describe('withSuppressedInvalidRefreshTokenConsoleError', () => {
  const originalConsoleError = console.error;

  afterEach(() => {
    console.error = originalConsoleError;
    vi.restoreAllMocks();
  });

  it('suppresses only the expected stale refresh-token console error during recovery', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await withSuppressedInvalidRefreshTokenConsoleError(async () => {
      console.error(new Error('Invalid Refresh Token: Already Used'));
      console.error(new Error('Network request failed'));
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'Network request failed' }));
  });
});
