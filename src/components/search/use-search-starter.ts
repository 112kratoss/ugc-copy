'use client';

import { useEffect, useState } from 'react';

import {
  isSearchStarterEmpty,
  parseSearchStarterResponse,
  type SearchStarterResponse,
} from '../../../ugc-mobile/lib/public-search-policy/search-starter';

// The browser's Supabase client, loaded when the request needs the session, as
// the typeahead loads it.
const loadSupabase = () => import('@/lib/supabase').then((module) => module.supabase);

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
 * reaches for it). `kept`: an answer this tab already has for the same
 * account, no older than SEARCH_STARTER_KEPT_MS, is drawn without a request.
 * The search page asks each time it opens, as before: it draws creators with
 * Follow, which a kept answer could show a followed creator among.
 */
export function useSearchStarter({ enabled = true, kept = false }: { enabled?: boolean; kept?: boolean } = {}): SearchStarterResponse | null {
  const [answer, setAnswer] = useState<SearchStarterResponse | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let stopWatching: (() => void) | null = null;
    let request: AbortController | null = null;
    // The account the answer on hand was asked for; undefined while none has been asked.
    let askedFor: string | null | undefined;
    const ask = async (supabase: Awaited<ReturnType<typeof loadSupabase>>) => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (controller.signal.aborted) return;
        const viewerId = session?.user?.id ?? null;
        askedFor = viewerId;
        if (kept && keptAnswer && keptAnswer.viewerId === viewerId && Date.now() - keptAnswer.at < SEARCH_STARTER_KEPT_MS) {
          setAnswer(keptAnswer.answer);
          return;
        }
        const response = await fetch('/api/search/starter', {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
          signal: controller.signal,
        });
        if (!response.ok) return;
        const parsed = parseSearchStarterResponse(await response.json().catch(() => null));
        if (controller.signal.aborted || !parsed || isSearchStarterEmpty(parsed)) return;
        keptAnswer = { viewerId, answer: parsed, at: Date.now() };
        setAnswer(parsed);
      } catch {
        // An extra: its failure is drawn as nothing.
      }
    };
    void loadSupabase().then((supabase) => {
      if (disposed) return;
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT') return;
        const next = event === 'SIGNED_OUT' ? null : session?.user?.id ?? null;
        if (askedFor === undefined || next === askedFor) return;
        // Another account: what was offered to the one before is not this one's.
        askedFor = undefined;
        keptAnswer = null;
        setAnswer(null);
        void ask(supabase);
      });
      stopWatching = () => data.subscription.unsubscribe();
      void ask(supabase);
    }).catch(() => {});
    return () => {
      disposed = true;
      stopWatching?.();
      request?.abort();
    };
  }, [enabled, kept]);
  return answer;
}
