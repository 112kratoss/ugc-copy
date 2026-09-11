/**
 * Deadlines for the Supabase auth requests a sign-out waits on.
 *
 * auth-js runs sign-out, session reads and token refreshes one at a time
 * behind an internal lock, and React Native's Android HTTP client has no
 * timeout of its own. A logout or refresh that stalls therefore holds that
 * lock indefinitely: the side menu sits on "Signing out…", and every later
 * getSession() queues behind it, including the guest bootstrap after
 * sign-out and the access token for each API call. Aborting the request is
 * what frees the lock. auth-js reports the abort as a retryable fetch error,
 * keeps the session and returns. A timer raced against the sign-out would
 * unblock the menu but leave the lock held.
 *
 * A logout always gets the deadline; only sign-out paths call it. A token
 * refresh gets it only while a sign-out is running. Outside one, cutting a
 * slow refresh short makes auth-js retry with a refresh token the server may
 * already have rotated, and a retry that lands after Supabase's reuse window
 * is rejected and signs the person out. During a sign-out that is the goal
 * anyway. Everything else, including sign-in on the same /token path, passes
 * through untouched.
 */

type FetchInput = RequestInfo | URL;
type AuthRequestKind = 'logout' | 'refresh';

export const SUPABASE_AUTH_REQUEST_DEADLINE_MS = 10_000;

export function createSupabaseAuthFetch({
  fetcher,
  deadlineMs = SUPABASE_AUTH_REQUEST_DEADLINE_MS,
}: { fetcher?: typeof fetch; deadlineMs?: number } = {}) {
  let signOutsInProgress = 0;
  // Refreshes on the wire without a deadline, each held as the function that
  // gives it one.
  const unarmedRefreshes = new Set<() => void>();

  const send = (input: FetchInput, init?: RequestInit): Promise<Response> =>
    // Resolved per request, so a fetch installed after this module loads is
    // the one that runs.
    (fetcher ?? globalThis.fetch)(input, init);

  const authFetch = (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const kind = authRequestKind(input);
    if (!kind) return send(input, init);

    const controller = new AbortController();
    const upstream = init?.signal;
    const abortFromUpstream = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) {
      abortFromUpstream();
    } else {
      upstream?.addEventListener('abort', abortFromUpstream, { once: true });
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      unarmedRefreshes.delete(arm);
      timeoutId ??= setTimeout(() => {
        controller.abort(new Error(`Supabase auth request timed out after ${deadlineMs}ms`));
      }, deadlineMs);
    };
    if (kind === 'logout' || signOutsInProgress > 0) {
      arm();
    } else {
      unarmedRefreshes.add(arm);
    }

    // Stand down once the response head arrives, not after the body. auth-js
    // reads an error body itself, and an abort landing in that read surfaces
    // as a non-retryable error, which deletes the session.
    return send(input, { ...init, signal: controller.signal }).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      unarmedRefreshes.delete(arm);
      upstream?.removeEventListener('abort', abortFromUpstream);
    });
  };

  /**
   * Runs sign-out work with the refresh deadline in force. Refreshes already
   * on the wire get it too, since they hold the lock the sign-out will queue
   * behind.
   */
  const duringSignOut = async <T>(work: () => Promise<T>): Promise<T> => {
    signOutsInProgress += 1;
    [...unarmedRefreshes].forEach((arm) => arm());
    try {
      return await work();
    } finally {
      signOutsInProgress -= 1;
    }
  };

  return { fetch: authFetch, duringSignOut };
}

function authRequestKind(input: FetchInput): AuthRequestKind | null {
  let url: URL;
  try {
    url = new URL(requestUrl(input));
  } catch {
    return null;
  }
  if (url.pathname.endsWith('/auth/v1/logout')) return 'logout';
  if (url.pathname.endsWith('/auth/v1/token') && url.searchParams.get('grant_type') === 'refresh_token') {
    return 'refresh';
  }
  return null;
}

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if ('href' in input) return input.href;
  return input.url;
}
