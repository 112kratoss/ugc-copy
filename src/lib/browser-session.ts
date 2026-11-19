import type { Session } from '@supabase/supabase-js';

import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';

type BrowserSupabaseModule = typeof import('@/lib/supabase');
export type BrowserSupabaseClient = BrowserSupabaseModule['supabase'];

/**
 * The client's code did not load: the connection dropped as it was asked for, or a deploy rotated
 * the chunk names while the tab was open. In a production build no retry fetches it again
 * (`loadBrowserSupabase`), so what the page cannot do without it says so and offers a reload.
 */
export class BrowserSupabaseLoadError extends Error {
  constructor(cause: unknown) {
    super('The Supabase client did not load.');
    this.name = 'BrowserSupabaseLoadError';
    this.cause = cause;
  }
}

const importClientModule = () => import('@/lib/supabase');
let importClient: () => Promise<BrowserSupabaseModule> = importClientModule;
let clientLoad: Promise<BrowserSupabaseClient> | null = null;

/**
 * The browser's Supabase client, loaded with its first use, as AuthProvider loads it: about 245 KB
 * of script (66 KB on the wire, production 2026-11-19) that pages imported up front for every
 * visitor, signed in or not. One load for every caller.
 *
 * A load that failed rejects with `BrowserSupabaseLoadError`, and the next call asks again; only
 * `next dev --webpack` (the E2E server) fetches the chunk anew then. Turbopack's runtime, which
 * `next build` uses, keeps one loader per chunk URL and hands a retry the same failed load, and
 * after a deploy the old name is gone anyway (`DeferredCreatorProfileCard` says more): in
 * production the client stays unloaded until the page is reloaded.
 */
export function loadBrowserSupabase(): Promise<BrowserSupabaseClient> {
  clientLoad ??= importClient()
    .then((module) => module.supabase)
    .catch((error: unknown) => {
      clientLoad = null;
      throw new BrowserSupabaseLoadError(error);
    });
  return clientLoad;
}

/**
 * This browser's session, as supabase-js reads it (`getSession`: refreshed first when it has
 * expired), or null. @supabase/ssr keeps the session in its cookie, so a browser without one has
 * none, and the client is not loaded to say so: a signed-out visit never fetches it. The cookie is
 * only the hint AuthProvider loads the client on (`hasSupabaseAuthCookie`): with one, the session
 * is read as it always was. Rejects when the client did not load (`BrowserSupabaseLoadError`).
 */
export async function readBrowserSession(): Promise<Session | null> {
  if (!hasSupabaseAuthCookie()) return null;
  const supabase = await loadBrowserSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

/**
 * Starts loading the client in a browser that holds a session cookie, so a page's first read of
 * the session does not wait for its script any longer than it did while the client came with the
 * page. A browser without one fetches nothing. A load that fails here is the first read's to report.
 */
export function preloadBrowserSupabaseForSession(): void {
  if (typeof window === 'undefined' || !hasSupabaseAuthCookie()) return;
  void loadBrowserSupabase().catch(() => undefined);
}

/**
 * Calls `onCookie` once this browser holds a session cookie: at once when it does, else when one
 * appears (a sign-in in another tab), looked for whenever this tab takes the focus or comes back
 * into view, as supabase-js looks for a session then (and said SIGNED_IN to a page that had loaded
 * it). Returns the function that stops looking.
 */
export function whenBrowserSessionCookie(onCookie: () => void): () => void {
  if (hasSupabaseAuthCookie()) {
    onCookie();
    return () => undefined;
  }
  const look = () => {
    if (!hasSupabaseAuthCookie()) return;
    stop();
    onCookie();
  };
  const lookWhenShown = () => {
    if (document.visibilityState === 'visible') look();
  };
  function stop() {
    window.removeEventListener('focus', look);
    document.removeEventListener('visibilitychange', lookWhenShown);
  }
  window.addEventListener('focus', look);
  document.addEventListener('visibilitychange', lookWhenShown);
  return stop;
}

/**
 * For tests: how the client's code arrives (a load that rejects or never ends, say), or the real
 * import again with null. The load on hand is forgotten either way.
 */
export function setBrowserSupabaseImportForTests(load: (() => Promise<BrowserSupabaseModule>) | null): void {
  importClient = load ?? importClientModule;
  clientLoad = null;
}
