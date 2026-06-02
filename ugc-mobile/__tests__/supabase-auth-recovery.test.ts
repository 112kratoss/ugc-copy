import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isInvalidRefreshTokenError,
  withSuppressedInvalidRefreshTokenConsoleError,
} from '../lib/supabase-auth-recovery';

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
