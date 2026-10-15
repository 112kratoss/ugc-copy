import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** How long a sign-out waits on Supabase's logout before giving up on it. */
export const LOGOUT_REQUEST_DEADLINE_MS = 10_000;

type FetchInput = RequestInfo | URL;

function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isLogoutRequest(input: FetchInput): boolean {
  try {
    return new URL(requestUrl(input)).pathname.endsWith('/auth/v1/logout');
  } catch {
    return false;
  }
}

/**
 * The browser client's fetch. The browser gives a request no deadline of its
 * own, so a stalled logout held the account menu's sign-out with nothing on
 * screen. Only the logout gets one: aborted, it comes back from auth-js as
 * `{ error }` with the session kept, and the sign-out paths then end the
 * session in this browser themselves (removeSupabaseAuthCookies). Everything
 * else passes through untouched; a token refresh above all must never be cut
 * short, since auth-js would retry it with a refresh token the server may
 * already have rotated.
 */
export function createLogoutDeadlineFetch({
  fetcher,
  deadlineMs = LOGOUT_REQUEST_DEADLINE_MS,
}: { fetcher?: typeof fetch; deadlineMs?: number } = {}): typeof fetch {
  return (input: FetchInput, init?: RequestInit) => {
    // Resolved per request, so a fetch installed after this module loads is
    // the one that runs.
    const send = fetcher ?? globalThis.fetch;
    if (!isLogoutRequest(input)) return send(input, init);

    const controller = new AbortController();
    const upstream = init?.signal;
    const abortFromUpstream = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) {
      abortFromUpstream();
    } else {
      upstream?.addEventListener('abort', abortFromUpstream, { once: true });
    }
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`Supabase logout timed out after ${deadlineMs}ms`));
    }, deadlineMs);

    // Stands down once the response head arrives.
    return send(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timeoutId);
      upstream?.removeEventListener('abort', abortFromUpstream);
    });
  };
}

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: createLogoutDeadlineFetch() },
});
