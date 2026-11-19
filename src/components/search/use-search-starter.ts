'use client';

import { useEffect, useState } from 'react';

import {
  loadBrowserSupabase,
  whenBrowserSessionCookie,
  type BrowserSupabaseClient,
} from '@/lib/browser-session';
import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';

import {
  isSearchStarterEmpty,
  parseSearchStarterResponse,
  type SearchStarterResponse,
} from '../../../ugc-mobile/lib/public-search-policy/search-starter';

/**
 * How long the top bar draws an answer it has without asking again. Its panel
 * is opened many times in a visit, on every page, and its lists are made
 * hourly: one request serves the visit's next ten minutes.
 */
export const SEARCH_STARTER_KEPT_MS = 10 * 60_000;

// The last answer, and the account it was asked for (null for a visitor): kept
// in this tab's memory, so the top bar's field, which leaves the page whenever
// Search is open, does not ask again each time it comes back.
let keptAnswer: { viewerId: string | null; answer: SearchStarterResponse; at: number } | null = null;

/**
 * How long a caller waits for the answer before it draws what it draws
 * without one (`settled`): a slow starter must not leave the search page
 * empty under its box for good.
 */
export const SEARCH_STARTER_SETTLE_MS = 2500;

/** For tests: a file's cases start with nothing kept. */
export function forgetKeptSearchStarter(): void {
  keptAnswer = null;
}

/**
 * What to start a search from (`GET /api/search/starter`), asked once per
 * mount and kept for its life: the search page draws the answer under the
 * empty box and again under a search that found nothing, the top bar's field
 * in the panel it opens on a click. Null until it lands, and for good when it
 * cannot be had (the route switched off or not there yet, a refusal, offline,
 * an answer that is not one, or one with nothing in it): the caller then draws
 * what it drew before. A visitor's request carries no token and is the edge's
 * to keep (about a minute); an account's carries its token, so a creator it
 * follows or has blocked is left out. So it is asked again when the account
 * changes (a sign-in or a sign-out on this page or in another tab), never for
 * the SIGNED_IN supabase-js repeats for the same account each time the tab
 * comes back into view.
 *
 * `enabled`: nothing is asked, and the Supabase client is not loaded, until it
 * is true (the top bar's field is on every page, and asks only once a person
 * reaches for it); then only in a browser with a session cookie, which a
 * visitor's has not (`browser-session.ts`). `kept`: an answer this tab already has for the same
 * account, no older than SEARCH_STARTER_KEPT_MS, is drawn without a request.
 * The search page asks each time it opens, as before: it draws creators with
 * Follow, which a kept answer could show a followed creator among.
 */
export function useSearchStarter(options: { enabled?: boolean; kept?: boolean } = {}): SearchStarterResponse | null {
  return useSearchStarterState(options).answer;
}

/**
 * The starter's answer, and whether the question is settled: true once the
 * answer is in, once it is known there will be none (a refusal, a failure, an
 * answer with nothing in it), and in any case after SEARCH_STARTER_SETTLE_MS;
 * false again while another account's answer is asked for.
 * The search page draws its idle invitation only then: drawn before, it stood
 * for a moment on every opening and was then pushed down by the recent
 * searches and replaced by the start screen (owner's brief, 2026-11-16:
 * nothing that flashes or jumps).
 */
export function useSearchStarterState({ enabled = true, kept = false }: { enabled?: boolean; kept?: boolean } = {}): {
  answer: SearchStarterResponse | null;
  settled: boolean;
} {
  const [answer, setAnswer] = useState<SearchStarterResponse | null>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const settle = () => { if (!disposed) setSettled(true); };
    let giveUp = window.setTimeout(settle, SEARCH_STARTER_SETTLE_MS);
    let stopWatching: (() => void) | null = null;
    let stopLookingForCookie: (() => void) | null = null;
    let request: AbortController | null = null;
    // The account the answer on hand was asked for; undefined while none has been asked.
    let askedFor: string | null | undefined;
    // `supabase`: the client, in a browser with a session cookie. Without one (null) there is no
    // session to read: the question is a visitor's.
    const ask = async (supabase: BrowserSupabaseClient | null) => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const session = supabase ? (await supabase.auth.getSession()).data.session : null;
        if (controller.signal.aborted) return;
        const viewerId = session?.user?.id ?? null;
        askedFor = viewerId;
        if (kept && keptAnswer && keptAnswer.viewerId === viewerId && Date.now() - keptAnswer.at < SEARCH_STARTER_KEPT_MS) {
          setAnswer(keptAnswer.answer);
          settle();
          return;
        }
        const response = await fetch('/api/search/starter', {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
          signal: controller.signal,
        });
        if (!response.ok) {
          settle();
          return;
        }
        const parsed = parseSearchStarterResponse(await response.json().catch(() => null));
        if (controller.signal.aborted) return;
        if (parsed && !isSearchStarterEmpty(parsed)) {
          keptAnswer = { viewerId, answer: parsed, at: Date.now() };
          setAnswer(parsed);
        }
        settle();
      } catch {
        // An extra: its failure is drawn as nothing. An abort is the next question's to settle.
        if (!controller.signal.aborted) settle();
      }
    };
    // Another account: what was offered to the one before is not this one's.
    const askForAnotherAccount = (supabase: BrowserSupabaseClient) => {
      askedFor = undefined;
      keptAnswer = null;
      setAnswer(null);
      // A new question, to be waited for as the first was (review of #830: the invitation
      // stood in for the moment the new account's answer took, and was then replaced).
      setSettled(false);
      window.clearTimeout(giveUp);
      giveUp = window.setTimeout(settle, SEARCH_STARTER_SETTLE_MS);
      void ask(supabase);
    };
    // The session and its changes, from the client. `askedAsVisitor`: the question was asked
    // without one, before a session cookie was written (a sign-in in another tab).
    const watchSession = (askedAsVisitor: boolean) => {
      void loadBrowserSupabase().then(async (supabase) => {
        if (disposed) return;
        const { data } = supabase.auth.onAuthStateChange((event, session) => {
          if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT') return;
          const next = event === 'SIGNED_OUT' ? null : session?.user?.id ?? null;
          if (askedFor === undefined || next === askedFor) return;
          askForAnotherAccount(supabase);
        });
        stopWatching = () => data.subscription.unsubscribe();
        if (!askedAsVisitor) {
          void ask(supabase);
          return;
        }
        // Asked again only for a cookie that names an account.
        const { data: { session } } = await supabase.auth.getSession();
        const next = session?.user?.id ?? null;
        if (!disposed && next !== null && next !== askedFor) askForAnotherAccount(supabase);
      }).catch(() => {
        // The client did not load (in a build it stays unloaded until a reload: browser-session.ts).
        // The question is a visitor's then, as the search page's own then are.
        if (!disposed && !askedAsVisitor) void ask(null);
      });
    };
    if (hasSupabaseAuthCookie()) {
      watchSession(false);
    } else {
      // No session cookie, so no session (@supabase/ssr keeps it there): asked as a visitor,
      // without loading the client. One written later is looked for as supabase-js looked.
      // Asked a moment later, as the client's load made it wait: development's StrictMode runs
      // this effect twice, and the run it takes down at once must ask nothing (the E2E server's
      // route counted two questions where the page drew one answer).
      void Promise.resolve().then(() => {
        if (!disposed) void ask(null);
      });
      stopLookingForCookie = whenBrowserSessionCookie(() => watchSession(true));
    }
    return () => {
      disposed = true;
      window.clearTimeout(giveUp);
      stopWatching?.();
      stopLookingForCookie?.();
      request?.abort();
    };
  }, [enabled, kept]);
  return { answer, settled };
}
