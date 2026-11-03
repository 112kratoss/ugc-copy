import { ApiError } from '@/lib/api-client';

/** A refusal (gone, private, blocked, rate-limited) answers the same again; a dropped connection may not. */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/**
 * How a screen reads a post once for something its card did not bring (the source row above a
 * remix's prompt, a post's settings in Details): kept for the session, asked again once after a
 * dropped connection and never after a refusal, and not again when the screen remounts or the app
 * comes back to the foreground, where a failed read would ask anew every time and what held its
 * place would flash. One policy for every such read, so none drifts from the others.
 */
export const ONE_TIME_POST_READ = {
  staleTime: Infinity,
  retry: retryUnlessRefused,
  retryOnMount: false,
  refetchOnWindowFocus: false,
} as const;
