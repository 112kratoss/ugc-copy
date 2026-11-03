import { ApiError } from '@/lib/api-client';

/** An answer that came back whole but without what the read asked for: asked again, it would say the same. */
export class IncompleteAnswerError extends Error {}

/**
 * A refusal (gone, private, blocked, rate-limited) answers the same again, and so does an answer
 * without what was asked (`IncompleteAnswerError`); a dropped connection may not.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  return failureCount < 1
    && !(error instanceof IncompleteAnswerError)
    && !(error instanceof ApiError && error.status >= 400 && error.status < 500);
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
