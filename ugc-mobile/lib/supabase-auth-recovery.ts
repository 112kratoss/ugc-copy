export function isInvalidRefreshTokenError(error: unknown) {
  const message = getErrorMessage(error);
  return message.includes('Invalid Refresh Token:');
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
