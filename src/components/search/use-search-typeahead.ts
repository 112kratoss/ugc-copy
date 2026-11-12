'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';


import {
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  isSearchTypeaheadShown,
  moveSearchTypeaheadHighlight,
  parseSearchSuggestResponse,
  searchTypeaheadAction,
  searchTypeaheadQuery,
  searchTypeaheadRows,
  searchTypeaheadSections,
  searchTypeaheadStatus,
  type SearchSuggestResponse,
  type SearchTypeaheadAction,
  type SearchTypeaheadRow,
} from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';

// What a request found for a query: null for one that failed, was refused or
// could not be read, which is drawn as nothing.
type TypeaheadAnswer = { query: string; response: SearchSuggestResponse | null };

// The browser's Supabase client, loaded when a request first needs the
// session, as the shell's other readers load it (AuthProvider,
// useUnreadAlertsCount): the top bar's search field is on every page, and a
// static import would put the client in every page's first bundle.
const loadSupabase = () => import('@/lib/supabase').then((module) => module.supabase);

// Answers kept while the box is on the page, so deleting a letter redraws the
// list it had without asking again. Only real answers are kept: a failure is
// asked about again the next time its text is typed.
const KEPT_ANSWERS = 30;

/**
 * The typeahead of a search box: what to ask and when, which answer may be
 * drawn, where the highlight is, and what each key does. The rules are the
 * search clients' shared ones (`ugc-mobile/lib/public-search-policy/
 * search-typeahead.ts`); this is the web's timer, request and key handling
 * around them. The box keeps the focus throughout: rows are never focused,
 * the highlighted one is named to assistive technology by
 * `aria-activedescendant`.
 */
export function useSearchTypeahead({ text, focused }: {
  /** What the box holds. */
  text: string;
  /** The focus is in the box (or its form). */
  focused: boolean;
}) {
  const listId = `${useId()}-search-typeahead`;
  const query = useMemo(() => searchTypeaheadQuery(text), [text]);
  const [answer, setAnswer] = useState<TypeaheadAnswer | null>(null);
  // The query the list was closed for (Escape) or committed with (Enter, a row).
  const [closedQuery, setClosedQuery] = useState<string | null>(null);
  // The highlighted row, for the query it was highlighted under: typing on returns the highlight to the box.
  const [highlight, setHighlight] = useState<{ query: string; index: number } | null>(null);
  const kept = useRef(new Map<string, SearchSuggestResponse>());
  // A 429 names how long the limit lasts: nothing is asked until then.
  const refusedUntil = useRef(0);
  // Ends the watch on the session, once a request has started one.
  const stopWatchingSession = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWatchingSession.current?.(), []);

  useEffect(() => {
    if (!focused || query === null) return;
    const keptAnswer = kept.current.get(query);
    if (keptAnswer) {
      setAnswer({ query, response: keptAnswer });
      return;
    }
    if (Date.now() < refusedUntil.current) return;
    // One request in flight at most: the pause before it is cancelled by the
    // next keystroke, and so is the request itself.
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      let response: SearchSuggestResponse | null = null;
      try {
        const supabase = await loadSupabase();
        if (!stopWatchingSession.current) {
          // An answer says whom its viewer follows and leaves out whom they
          // are blocked with: it is one account's, and goes when the account
          // does. Watched from the first request on; before it nothing is kept.
          const { data } = supabase.auth.onAuthStateChange((event) => {
            if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT' && event !== 'USER_UPDATED') return;
            kept.current.clear();
            setAnswer(null);
          });
          stopWatchingSession.current = () => data.subscription.unsubscribe();
        }
        const { data: { session } } = await supabase.auth.getSession();
        if (controller.signal.aborted) return;
        const reply = await fetch(`/api/search/suggest?q=${encodeURIComponent(query)}`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
          signal: controller.signal,
        });
        const body = await reply.json().catch(() => null) as { retryAfterSeconds?: unknown } | null;
        if (reply.status === 429) {
          const seconds = typeof body?.retryAfterSeconds === 'number' && body.retryAfterSeconds > 0 ? body.retryAfterSeconds : 5;
          refusedUntil.current = Date.now() + Math.min(seconds, 60) * 1000;
        }
        response = reply.ok ? parseSearchSuggestResponse(body) : null;
      } catch {
        // Offline, aborted, or not JSON: a suggestion is an extra, and its failure is nothing.
        response = null;
      }
      if (controller.signal.aborted) return;
      if (response) {
        kept.current.set(query, response);
        if (kept.current.size > KEPT_ANSWERS) {
          const oldest = kept.current.keys().next().value;
          if (oldest !== undefined) kept.current.delete(oldest);
        }
      }
      setAnswer({ query, response });
    }, SEARCH_TYPEAHEAD_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [focused, query]);

  // A close belongs to the text it was made on: once the box holds another,
  // it is forgotten, so the same text typed again later is offered its list.
  // Adjusted while rendering, as React asks of state that follows a value:
  // an effect would draw the stale close for a frame first.
  const [closedCheckedFor, setClosedCheckedFor] = useState(query);
  if (closedCheckedFor !== query) {
    setClosedCheckedFor(query);
    if (closedQuery !== null && closedQuery !== query) setClosedQuery(null);
  }

  // An answer is drawn only for the text the box holds now: one for an earlier text is nothing.
  const currentResponse = answer !== null && answer.query === query ? answer.response : null;
  const sections = useMemo(() => searchTypeaheadSections(currentResponse, query), [currentResponse, query]);
  const rows = useMemo(() => searchTypeaheadRows(sections), [sections]);
  const shown = isSearchTypeaheadShown({
    focused,
    query,
    answerQuery: answer?.query ?? null,
    closedQuery,
    rowCount: rows.length,
  });
  const activeIndex = shown && highlight !== null && highlight.query === query && highlight.index < rows.length
    ? highlight.index
    : null;

  const close = useCallback(() => {
    setClosedQuery(query);
    setHighlight(null);
  }, [query]);

  /** A row was chosen: what to do, with the list closed for the text the box will then hold. */
  const pick = useCallback((row: SearchTypeaheadRow): SearchTypeaheadAction => {
    const action = searchTypeaheadAction(row);
    setClosedQuery(action.type === 'search' ? searchTypeaheadQuery(action.query) : query);
    setHighlight(null);
    return action;
  }, [query]);

  /**
   * A key in the box. Returns the action of a row chosen with Enter, or null.
   * A key it used is `preventDefault`ed, which the field reads to leave it
   * alone (its own Escape clears the box).
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>): SearchTypeaheadAction | null => {
    // A key that only confirms an input method's composition is not a choice.
    if (event.nativeEvent.isComposing) return null;
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      if (query === null || rows.length === 0) return null;
      // Home and End are the caret's keys until a row is highlighted.
      if ((key === 'Home' || key === 'End') && activeIndex === null) return null;
      event.preventDefault();
      // An arrow opens a list that was closed for this text.
      if (closedQuery === query) setClosedQuery(null);
      const next = moveSearchTypeaheadHighlight(shown ? activeIndex : null, key, rows.length);
      setHighlight(next === null ? null : { query, index: next });
      return null;
    }
    if (key === 'Escape') {
      if (!shown) return null;
      // Closes the list and keeps the text; with the list closed, Escape is the field's own.
      event.preventDefault();
      close();
      return null;
    }
    if (key === 'Enter') {
      if (shown && activeIndex !== null) {
        event.preventDefault();
        return pick(rows[activeIndex]);
      }
      // Nothing highlighted: the search is what is typed, and the list gets out of its way.
      close();
    }
    return null;
  }, [activeIndex, close, closedQuery, pick, query, rows, shown]);

  const highlightRow = useCallback((index: number) => {
    if (query !== null) setHighlight({ query, index });
  }, [query]);

  return {
    listId,
    /** The list is drawn. */
    shown,
    sections,
    rows,
    activeIndex,
    activeOptionId: activeIndex === null ? undefined : searchTypeaheadOptionId(listId, activeIndex),
    /** For a polite live region: "5 suggestions" while the list is drawn, nothing otherwise. */
    status: shown ? searchTypeaheadStatus(rows.length) : '',
    onKeyDown,
    pick,
    highlightRow,
    close,
  };
}

export function searchTypeaheadOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}
