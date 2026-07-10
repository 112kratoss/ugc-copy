export function isInvalidRefreshTokenError(error: unknown) {
  const message = getErrorMessage(error);
  return message.includes('Invalid Refresh Token:');
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
