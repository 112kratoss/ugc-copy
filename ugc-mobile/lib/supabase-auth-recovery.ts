import type { Session } from '@supabase/supabase-js';

export function isInvalidRefreshTokenError(error: unknown) {
  const message = getErrorMessage(error);
  return message.includes('Invalid Refresh Token:');
}

/**
 * Whether a failed refresh means the session has ended for good.
 *
 * This is the line auth-js draws before it deletes a stored session and emits
 * SIGNED_OUT: any auth error except a retryable fetch failure (a network error
 * or a 5xx, which it keeps the session through). Checked on the same fields
 * auth-js checks, so the app's teardown never runs for a session auth-js is
 * still holding, and this module stays free of the client import.
 */
export function isSessionEndedRefreshError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('__isAuthError' in error)) return false;
  return (error as { name?: unknown }).name !== 'AuthRetryableFetchError';
}

/**
 * The other side of that line: a refresh that failed on the network or on a
 * 502/503/504. auth-js keeps the stored session through it and tries again.
 */
export function isRetryableRefreshError(error: unknown) {
  if (typeof error !== 'object' || error === null || !('__isAuthError' in error)) return false;
  return (error as { name?: unknown }).name === 'AuthRetryableFetchError';
}

/**
 * The session auth-js stored, when the stored text is one it would load itself:
 * an access token, a refresh token, an expiry and a user. Anything else reads
 * as no session, so a damaged or foreign value can never stand in for one.
 */
export function parsePersistedSupabaseSession(stored: string | null): Session | null {
  if (!stored) return null;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const session = value as Record<string, unknown>;
  const user = session.user as Record<string, unknown> | null | undefined;
  if (
    typeof session.access_token !== 'string'
    || typeof session.refresh_token !== 'string'
    || typeof session.expires_at !== 'number'
    || typeof user !== 'object'
    || user === null
    || typeof user.id !== 'string'
    || !user.id
  ) {
    return null;
  }
  return value as Session;
}

export function isNetworkRequestFailedError(error: unknown) {
  return getErrorMessage(error).includes('Network request failed');
}

export function supabaseNetworkFailureMessage(root: string) {
  if (isLocalSupabaseRoot(root)) {
    return `Could not reach local Supabase at ${root}. Start Docker/Supabase or switch ugc-mobile/.env.local back to the hosted Supabase URL.`;
  }

  return 'Could not reach Supabase auth. Check your connection and EXPO_PUBLIC_SUPABASE_URL.';
}

export async function withSuppressedInvalidRefreshTokenConsoleError<T>(task: () => Promise<T>) {
  const originalConsoleError = console.error;

  console.error = (...args: unknown[]) => {
    if (args.some(isInvalidRefreshTokenError)) {
      return;
    }

    originalConsoleError(...args);
  };

  try {
    return await task();
  } finally {
    console.error = originalConsoleError;
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }

  return '';
}

function isLocalSupabaseRoot(root: string) {
  try {
    const hostname = new URL(root).hostname;
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '10.0.2.2'
      || hostname.startsWith('192.168.')
      || hostname.endsWith('.local');
  } catch {
    return false;
  }
}
