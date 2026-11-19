import type { Session } from '@supabase/supabase-js';

import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';

export type BrowserSupabaseClient = typeof import('@/lib/supabase')['supabase'];

let clientLoad: Promise<BrowserSupabaseClient> | null = null;

/**
 * The browser's Supabase client, loaded with its first use, as AuthProvider loads it: about 245 KB
 * of script (66 KB on the wire, production 2026-11-19) that pages imported up front for every
 * visitor, signed in or not. One load for every caller; one that failed is asked again by the next.
 */
export function loadBrowserSupabase(): Promise<BrowserSupabaseClient> {
  clientLoad ??= import('@/lib/supabase')
    .then((module) => module.supabase)
    .catch((error: unknown) => {
      clientLoad = null;
      throw error;
    });
  return clientLoad;
}

/**
 * This browser's session, as supabase-js reads it (`getSession`: refreshed first when it has
 * expired), or null. @supabase/ssr keeps the session in its cookie, so a browser without one has
 * none, and the client is not loaded to say so: a signed-out visit never fetches it. The cookie is
 * only the hint AuthProvider loads the client on (`hasSupabaseAuthCookie`): with one, the session
 * is read as it always was.
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
 * page. A browser without one fetches nothing.
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
