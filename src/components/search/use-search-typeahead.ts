'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';


import {
  SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS,
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  SEARCH_TYPEAHEAD_KEPT_ANSWERS,
  SEARCH_TYPEAHEAD_KEPT_ANSWER_MS,
  SEARCH_TYPEAHEAD_PRESS_SETTLE_MS,
  isSearchTypeaheadPressAccepted,
  isSearchTypeaheadShown,
  moveSearchTypeaheadHighlight,
  parseSearchSuggestResponse,
  placeSearchTypeaheadRows,
  searchTypeaheadAction,
  searchTypeaheadDrawn,
  searchTypeaheadQuery,
  searchTypeaheadRows,
  searchTypeaheadStatus,
  type SearchSuggestResponse,
  type SearchTypeaheadAction,
  type SearchTypeaheadAnswer,
  type SearchTypeaheadPlacement,
  type SearchTypeaheadRow,
} from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';

// The browser's Supabase client, loaded when a request first needs the
// session, as the shell's other readers load it (AuthProvider,
// useUnreadAlertsCount): the top bar's search field is on every page, and a
// static import would put the client in every page's first bundle.
const loadSupabase = () => import('@/lib/supabase').then((module) => module.supabase);

// An answer kept so that deleting a letter redraws the list it had without
// asking again. Only real answers are kept (a failure is asked about again the
// next time its text is typed), only while the box keeps the focus, and none
// is drawn again once it is older than SEARCH_TYPEAHEAD_KEPT_ANSWER_MS: an
// answer says whom the viewer follows and leaves out whom they are blocked
// with, and both change on other pages.
type KeptAnswer = { response: SearchSuggestResponse; at: number };

/**
 * The typeahead of a search box: what to ask and when, what is drawn while
 * an answer is on its way, where the highlight is, and what each key does. The rules are the
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
  const [answer, setAnswer] = useState<SearchTypeaheadAnswer | null>(null);
  // The query the list was closed for (Escape) or committed with (Enter, a row).
  const [closedQuery, setClosedQuery] = useState<string | null>(null);
  // The highlighted row, by its key and for the query it was highlighted
  // under: typing on returns the highlight to the box, and a list that
  // changes under the highlight (a stale one replaced by its answer) keeps it
  // on that same row or, when the row is gone, returns it to the box. An
  // index would move it to whatever row took its place.
  const [highlight, setHighlight] = useState<{ query: string; key: string } | null>(null);
  const kept = useRef(new Map<string, KeptAnswer>());
  // A 429 names how long the limit lasts: nothing is asked until then.
  const refusedUntil = useRef(0);
  // Whose answers these are: counted up when the account changes, so an
  // answer still on its way for the account before is not drawn or kept.
  const viewerEpoch = useRef(0);
  // Ends the watch on the session, once a request has started one. The box
  // can leave the page (the top bar's does, on every route change to Search)
  // while the first request is still loading the client: a watch started
  // after that would never be ended.
  const stopWatchingSession = useRef<(() => void) | null>(null);
  const unmounted = useRef(false);
  // Where each drawn row stands and since when: a press on a row that has
  // only just come to stand there does not count.
  const placement = useRef<SearchTypeaheadPlacement | null>(null);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      stopWatchingSession.current?.();
      stopWatchingSession.current = null;
    };
  }, []);

  useEffect(() => {
    if (!focused) {
      // Kept for one focus of the box: what is typed after coming back is asked again.
      kept.current.clear();
      return;
    }
    if (query === null) return;
    const keptAnswer = kept.current.get(query);
    if (keptAnswer && Date.now() - keptAnswer.at < SEARCH_TYPEAHEAD_KEPT_ANSWER_MS) {
      setAnswer({ query, response: keptAnswer.response });
      return;
    }
    kept.current.delete(query);
    if (Date.now() < refusedUntil.current) {
      // Not asked: recorded as an answer with nothing, so the list of the
      // text before does not stay on show for a text that will get none.
      setAnswer({ query, response: null });
      return;
    }
    // One request in flight at most: the pause before it is cancelled by the
    // next keystroke, and so is the request itself.
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      let response: SearchSuggestResponse | null = null;
      const epoch = viewerEpoch.current;
      try {
        const supabase = await loadSupabase();
        if (unmounted.current) return;
        if (!stopWatchingSession.current) {
          // An answer is one account's, and goes when the account does.
          // Watched from the first request on; before it nothing is kept.
          const { data } = supabase.auth.onAuthStateChange((event) => {
            if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT' && event !== 'USER_UPDATED') return;
            viewerEpoch.current += 1;
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
      if (controller.signal.aborted || unmounted.current) return;
      // Asked as the account before: not this one's answer.
      if (epoch !== viewerEpoch.current) response = null;
      if (response) {
        kept.current.set(query, { response, at: Date.now() });
        if (kept.current.size > SEARCH_TYPEAHEAD_KEPT_ANSWERS) {
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

  // State that follows the box, adjusted while rendering, as React asks of
  // state that follows a value (an effect would draw the stale state for a
  // frame first):
  //   - a close belongs to the text it was made on: once the box holds
  //     another, it is forgotten, so the same text typed again later is
  //     offered its list;
  //   - an answer is kept on show for the text typed after it only (the
  //     shared rule, searchTypeaheadDrawn): it goes when the box is emptied,
  //     and when the focus leaves, so coming back never draws what was asked
  //     before.
  const [checkedFor, setCheckedFor] = useState({ focused, query });
  if (checkedFor.focused !== focused || checkedFor.query !== query) {
    setCheckedFor({ focused, query });
    if (closedQuery !== null && closedQuery !== query) setClosedQuery(null);
    if ((!focused || query === null) && answer !== null) setAnswer(null);
  }

  // This text's answer, or until it arrives the one before it, marked stale.
  const { sections, stale } = useMemo(() => searchTypeaheadDrawn(answer, query), [answer, query]);
  const rows = useMemo(() => searchTypeaheadRows(sections), [sections]);
  const shown = isSearchTypeaheadShown({ focused, query, closedQuery, rowCount: rows.length });
  const highlightedAt = shown && highlight !== null && highlight.query === query
    ? rows.findIndex((row) => row.key === highlight.key)
    : -1;
  const activeIndex = highlightedAt >= 0 ? highlightedAt : null;

  // The rows' places, kept as they are drawn (the shared rule,
  // placeSearchTypeaheadRows): a row that has just come to stand where it is
  // takes no press for a moment, so a press aimed at the row before it does
  // not open this one. A press handler runs after this effect: React runs
  // pending effects before it handles a press.
  useEffect(() => {
    placement.current = shown ? placeSearchTypeaheadRows(placement.current, rows, Date.now()) : null;
  }, [rows, shown]);

  // The list says it is busy for that moment, as it does while its rows are
  // stale: from a change of its rows while it is on show until they have
  // stood for the same time (a little longer than the rule itself asks of a
  // row that did not move). A list that comes on show has nothing to settle.
  // Adjusted while rendering, as the close above is.
  const rowOrder = useMemo(() => rows.map((row) => row.key).join('\n'), [rows]);
  const drawnOrder = shown ? rowOrder : null;
  // The order on show, and whether it has stood: any change while on show
  // unsettles it, a change back to an order it had a moment ago included.
  const [order, setOrder] = useState<{ drawn: string | null; settled: boolean }>({ drawn: null, settled: true });
  if (order.drawn !== drawnOrder) {
    setOrder({ drawn: drawnOrder, settled: order.drawn === null || drawnOrder === null });
  }
  const settling = shown && order.drawn === drawnOrder && !order.settled;
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => {
      setOrder((current) => (current.drawn === rowOrder ? { drawn: rowOrder, settled: true } : current));
    }, SEARCH_TYPEAHEAD_PRESS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [rowOrder, settling]);

  // What the live region says: the count of this text's own list, once it has
  // stood for a pause in typing. A stale list changes nothing (the words it
  // had stay, and a polite region given the same words says nothing), so the
  // count is said when it changes and at most once per pause.
  const [status, setStatus] = useState('');
  const rowCount = rows.length;
  useEffect(() => {
    if (shown && stale) return;
    const next = shown ? searchTypeaheadStatus(rowCount) : '';
    const timer = window.setTimeout(() => setStatus(next), SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [rowCount, shown, stale]);

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
   * A row was pressed with a pointer or a finger: its action, or null for a
   * press that does not count because the row has only just come to stand
   * under it (isSearchTypeaheadPressAccepted). The keys choose with `pick`:
   * their highlight is on a row by its key, wherever it stands.
   */
  const press = useCallback((row: SearchTypeaheadRow): SearchTypeaheadAction | null => (
    isSearchTypeaheadPressAccepted(placement.current, row.key, Date.now()) ? pick(row) : null
  ), [pick]);

  /**
   * A key in the box. Returns the action of a row chosen with Enter, or null.
   * A key it used is `preventDefault`ed, which the field reads to leave it
   * alone (its own Escape clears the box).
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>): SearchTypeaheadAction | null => {
    // A key that only confirms an input method's composition is not a choice.
    // Safari sends the Enter that ends a composition after `compositionend`,
    // so it no longer says it is composing: its key code, 229, still does.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return null;
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      if (query === null || rows.length === 0) return null;
      // Home and End are the caret's keys until a row is highlighted.
      if ((key === 'Home' || key === 'End') && activeIndex === null) return null;
      event.preventDefault();
      // An arrow opens a list that was closed for this text.
      if (closedQuery === query) setClosedQuery(null);
      const next = moveSearchTypeaheadHighlight(shown ? activeIndex : null, key, rows.length);
      setHighlight(next === null ? null : { query, key: rows[next].key });
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
    const row = rows[index];
    if (query !== null && row) setHighlight({ query, key: row.key });
  }, [query, rows]);

  return {
    listId,
    /** The list is drawn. */
    shown,
    /** What is drawn is the answer to the text before this one: this text's is on its way. */
    stale: shown && stale,
    /** The list is changing or has just changed: stale, or a row moved a moment ago and takes no press yet. */
    busy: shown && (stale || settling),
    sections,
    rows,
    activeIndex,
    activeOptionId: activeIndex === null ? undefined : searchTypeaheadOptionId(listId, activeIndex),
    /** For a polite live region: "5 suggestions" once this text's list has stood for a pause, nothing once it is gone. */
    status,
    onKeyDown,
    pick,
    press,
    highlightRow,
    close,
  };
}

export function searchTypeaheadOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}
