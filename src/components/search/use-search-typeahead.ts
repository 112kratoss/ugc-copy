'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { loadBrowserSupabase } from '@/lib/browser-session';
import { hasSupabaseAuthCookie } from '@/lib/supabase-auth-cookie';

import {
  SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS,
  SEARCH_TYPEAHEAD_CATALOG_PARAM,
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  SEARCH_TYPEAHEAD_KEPT_ANSWERS,
  SEARCH_TYPEAHEAD_KEPT_ANSWER_MS,
  SEARCH_TYPEAHEAD_OFFER_ALL,
  SEARCH_TYPEAHEAD_PRESS_SETTLE_MS,
  isSearchTypeaheadPressAccepted,
  searchTypeaheadAsks,
  isSearchTypeaheadShown,
  moveSearchTypeaheadHighlight,
  parseSearchSuggestResponse,
  placeSearchTypeaheadRows,
  searchTypeaheadUnsettledRows,
  searchTypeaheadAction,
  searchTypeaheadDrawn,
  searchTypeaheadQuery,
  searchTypeaheadRows,
  searchTypeaheadStatus,
  type SearchSuggestResponse,
  type SearchTypeaheadAction,
  type SearchTypeaheadAnswer,
  type SearchTypeaheadOffer,
  type SearchTypeaheadPlacement,
  type SearchTypeaheadRow,
  type SearchTypeaheadSection,
} from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';
import type { SearchEntity } from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';

// The browser's Supabase client (`loadBrowserSupabase`) is loaded when a request
// first needs the session, as the shell's other readers load it (AuthProvider,
// useUnreadAlertsCount): the top bar's search field is on every page, and a
// static import would put the client in every page's first bundle. A browser
// with no session cookie never loads it here.

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
// No row is settling: one array, so a list that has settled keeps its props.
const NO_ROWS: readonly string[] = [];

// No recent search: one array, so a box without a list keeps its memo.
const NO_RECENTS: readonly string[] = [];

// No model or tool named: one array, so a caller's effect on it runs only when an answer names some.
const NO_ENTITIES: readonly SearchEntity[] = [];

// Nothing offered before typing: one array, so a box without a start panel keeps its memo.
const NO_START: readonly SearchTypeaheadSection[] = [];

/** What the list is closed for while the box holds nothing: the empty box's own panel (`start`). */
const EMPTY_BOX = '';

/** A row's action, with the row it came from: a caller may read what else the row says (where it was offered). */
export type SearchTypeaheadPick<Row extends SearchTypeaheadRow = SearchTypeaheadRow> = SearchTypeaheadAction & { row: Row };

export function useSearchTypeahead<Row extends SearchTypeaheadRow = SearchTypeaheadRow>({ text, focused, closedFor = null, recents = NO_RECENTS, offer = SEARCH_TYPEAHEAD_OFFER_ALL, start = NO_START as readonly (SearchTypeaheadSection & { rows: Row[] })[] }: {
  /** What the box holds. */
  text: string;
  /** The focus is in the box (or its form). */
  focused: boolean;
  /**
   * A text the list starts closed for, as if committed with Enter: the search
   * page opened from the top bar's field (search-field-handoff.ts). Read once.
   */
  closedFor?: string | null;
  /** This browser's recent searches, most recent first: the ones the text matches are offered first. */
  recents?: readonly string[];
  /** Which kinds the box offers (the shared SearchTypeaheadOffer): the search page leaves out what its tab's results draw. */
  offer?: SearchTypeaheadOffer;
  /**
   * What the box offers before anything is typed (the top bar's start panel,
   * search-start-panel.ts): drawn while the box has the focus and holds
   * nothing, and kept on show over the first letters until their own list has
   * a row or their answer has come, so the panel is filled in place and never
   * goes and comes back. A box without one (the search page, whose start
   * screen is the page under it) opens no list on an empty box, as before.
   */
  start?: readonly (SearchTypeaheadSection & { rows: Row[] })[];
}) {
  const listId = `${useId()}-search-typeahead`;
  const query = useMemo(() => searchTypeaheadQuery(text), [text]);
  const asks = searchTypeaheadAsks(query, offer);
  const [answer, setAnswer] = useState<SearchTypeaheadAnswer | null>(null);
  // The query the list was closed for (Escape) or committed with (Enter, a row).
  const [closedQuery, setClosedQuery] = useState<string | null>(
    () => (closedFor === null ? null : searchTypeaheadQuery(closedFor)),
  );
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
    // Nothing its answer could hold would be drawn here (a handle on a box
    // that offers no creators): not asked (and nothing of an answer is drawn, below).
    if (!asks) return;
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
        // A browser with no session cookie has no session (@supabase/ssr keeps it there): a
        // visitor's request is sent bare, and the client is not loaded for it. What it keeps is
        // kept for this focus of the box alone (above), which a sign-in elsewhere ends.
        let session: Session | null = null;
        // A client that did not load asks as a visitor, as the search page then does.
        const supabase = hasSupabaseAuthCookie() ? await loadBrowserSupabase().catch(() => null) : null;
        if (unmounted.current) return;
        if (supabase) {
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
          ({ data: { session } } = await supabase.auth.getSession());
        }
        if (controller.signal.aborted) return;
        // Asked for every name the product keeps (`catalog=1`): this box opens the creator for a
        // catalog model nobody has posted with, and searches the query a row carries.
        const reply = await fetch(`/api/search/suggest?q=${encodeURIComponent(query)}&${SEARCH_TYPEAHEAD_CATALOG_PARAM}=1`, {
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
  }, [asks, focused, query]);

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
  //   - a close of the empty box's panel lasts for that focus only: coming
  //     back to the field is asking for it again.
  const closeKey = query ?? EMPTY_BOX;
  const [checkedFor, setCheckedFor] = useState({ focused, query });
  if (checkedFor.focused !== focused || checkedFor.query !== query) {
    setCheckedFor({ focused, query });
    if (closedQuery !== null && (closedQuery !== closeKey || (!focused && closedQuery === EMPTY_BOX))) setClosedQuery(null);
    if ((!focused || query === null) && answer !== null) setAnswer(null);
    // A highlight belongs to the text it was put on, and goes with it: typed away from and back
    // to, the text has the highlight in the box again, so Enter searches what is typed (review of
    // #830: a start row highlighted on the empty box was highlighted again after a letter typed
    // and deleted, and Enter then picked it).
    if (highlight !== null && highlight.query !== closeKey) setHighlight(null);
  }

  // This text's answer, or until it arrives the one before it, marked stale.
  const typed = useMemo(
    // A text not asked about draws no answer, not even the one before it. Asked with the catalog,
    // models and tools are drawn from two characters; drawn on the web, a row the web has nothing to
    // open for is left out, and a name drawn as a model's or tool's row is not suggested again.
    () => searchTypeaheadDrawn(asks ? answer : null, query, { recents, offer, catalog: true, platform: 'web' }),
    [answer, asks, offer, query, recents],
  );

  // The start panel, and how long it stays over what is typed: while the text
  // has no row of its own yet and its answer is still on its way. Only a panel
  // that was on show is kept (`startHeld`): one closed with Escape (on the
  // empty box, or while it stood over the first letters: review of #830), or a
  // list that typing on has emptied, never brings it back mid-word.
  const typedHasRows = typed.sections.length > 0;
  const awaiting = asks && query !== null && answer?.query !== query;
  const startOnShow = query === null && focused && closedQuery !== EMPTY_BOX && start.length > 0;
  const [startHeld, setStartHeld] = useState(false);
  const held = query !== null && focused && startHeld && !typedHasRows && awaiting && start.length > 0 && closedQuery !== closeKey;
  if ((startOnShow || held) !== startHeld) setStartHeld(startOnShow || held);
  const startDrawn = query === null || held;

  const sections: readonly SearchTypeaheadSection[] = startDrawn ? start : typed.sections;
  const stale = startDrawn ? held : typed.stale;
  const rows = useMemo(() => searchTypeaheadRows(sections) as Row[], [sections]);
  const shown = startDrawn
    ? focused && closedQuery !== closeKey && rows.length > 0
    : isSearchTypeaheadShown({ focused, query, closedQuery, rowCount: rows.length });
  // Held by the text it was put on: typing on returns the highlight to the box.
  const highlightedAt = shown && highlight !== null && highlight.query === closeKey
    ? rows.findIndex((row) => row.key === highlight.key)
    : -1;
  const activeIndex = highlightedAt >= 0 ? highlightedAt : null;

  // The rows' places, kept as they are drawn (the shared rule,
  // placeSearchTypeaheadRows): a row that has just come to stand where it is
  // takes no press for a moment, so a press aimed at the row before it does
  // not open this one. Kept in a layout effect, which React runs inside the
  // commit that draws the rows: no press can find them drawn in places this
  // has not recorded. (A passive effect may run after the paint when the
  // change came from an answer arriving and not from a key, and a press
  // landing in between was judged by the places before: a row that had only
  // just moved under the pointer took it.)
  useLayoutEffect(() => {
    placement.current = shown ? placeSearchTypeaheadRows(placement.current, rows, Date.now()) : null;
  }, [rows, shown]);

  // What the list says of that moment: the rows that do not take a press yet
  // (the shared rule, searchTypeaheadUnsettledRows), marked and drawn as every
  // other row, and the list busy, as it is while its rows are stale. From a change of the order
  // on show that moved a row until the order has stood for the same time (a
  // little longer than the press rule asks of a row an earlier change moved).
  // A list that comes on show has nothing to settle, and neither has a change
  // that moves no row. Adjusted while rendering, as the close above is.
  const rowOrder = useMemo(() => rows.map((row) => row.key).join('\n'), [rows]);
  const drawnOrder = shown ? rowOrder : null;
  const [order, setOrder] = useState<{ drawn: string | null; unsettled: readonly string[] }>({ drawn: null, unsettled: NO_ROWS });
  if (order.drawn !== drawnOrder) {
    setOrder({
      drawn: drawnOrder,
      unsettled: order.drawn === null || drawnOrder === null
        ? NO_ROWS
        : searchTypeaheadUnsettledRows({ order: order.drawn.split('\n'), unsettled: order.unsettled }, rows.map((row) => row.key)),
    });
  }
  const settlingRows = shown && order.drawn === drawnOrder ? order.unsettled : NO_ROWS;
  const settling = settlingRows.length > 0;
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => {
      setOrder((current) => (current.drawn === rowOrder ? { drawn: rowOrder, unsettled: NO_ROWS } : current));
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

  // A list taller than its room scrolls inside itself, and the highlight is only a name the box
  // says (`aria-activedescendant`), which no browser scrolls to: a row the keys highlight is
  // scrolled into the list's view (review of #830). Only for the keys: the pointer highlights the
  // row it is over, which is in view already, and scrolling under it would move the rows.
  const scrollToHighlight = useRef(false);
  const activeOptionId = activeIndex === null ? undefined : searchTypeaheadOptionId(listId, activeIndex);
  useLayoutEffect(() => {
    if (!scrollToHighlight.current) return;
    scrollToHighlight.current = false;
    const row = activeOptionId ? document.getElementById(activeOptionId) : null;
    // `?.()`: a browser without it (and jsdom) leaves the list where it is.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId]);

  const close = useCallback(() => {
    setClosedQuery(closeKey);
    setHighlight(null);
  }, [closeKey]);

  /** A click in a field that has the focus already: a list closed for this text is asked for again. */
  const reopen = useCallback(() => {
    setClosedQuery((current) => (current === closeKey ? null : current));
  }, [closeKey]);

  /**
   * The list closed for a text the box is about to hold that no row of it said: the page puts a
   * model's or tool's own search in the box when that row is chosen (review of #828, S1). A close is
   * kept only for the text it was made on, so one made on the typed text would open the list again
   * over the search.
   */
  const closeFor = useCallback((text: string) => {
    setClosedQuery(searchTypeaheadQuery(text) ?? EMPTY_BOX);
    setHighlight(null);
  }, []);

  /** A row was chosen: what to do, with the list closed for the text the box will then hold. */
  const pick = useCallback((row: Row): SearchTypeaheadPick<Row> => {
    const action = searchTypeaheadAction(row);
    setClosedQuery(action.type === 'search' ? searchTypeaheadQuery(action.query) : closeKey);
    setHighlight(null);
    return { ...action, row };
  }, [closeKey]);

  /**
   * A row was pressed with a pointer or a finger: its action, or null for a
   * press that does not count because the row has only just come to stand
   * under it (isSearchTypeaheadPressAccepted). The keys choose with `pick`:
   * their highlight is on a row by its key, wherever it stands.
   */
  const press = useCallback((row: Row): SearchTypeaheadPick<Row> | null => (
    isSearchTypeaheadPressAccepted(placement.current, row.key, Date.now()) ? pick(row) : null
  ), [pick]);

  /**
   * A key in the box. Returns the action of a row chosen with Enter, or null.
   * A key it used is `preventDefault`ed, which the field reads to leave it
   * alone (its own Escape clears the box).
   */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>): SearchTypeaheadPick<Row> | null => {
    // A key that only confirms an input method's composition is not a choice.
    // Safari sends the Enter that ends a composition after `compositionend`,
    // so it no longer says it is composing: its key code, 229, still does.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return null;
    const { key } = event;
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      // Nothing to walk: an empty box with no start panel, or a text with no row.
      if (rows.length === 0) return null;
      // Home and End are the caret's keys until a row is highlighted.
      if ((key === 'Home' || key === 'End') && activeIndex === null) return null;
      event.preventDefault();
      // An arrow opens a list that was closed for this text.
      if (closedQuery === closeKey) setClosedQuery(null);
      const next = moveSearchTypeaheadHighlight(shown ? activeIndex : null, key, rows.length);
      setHighlight(next === null ? null : { query: closeKey, key: rows[next].key });
      // A key moved the highlight: the row it lands on is brought into the list's view.
      scrollToHighlight.current = true;
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
  }, [activeIndex, close, closeKey, closedQuery, pick, rows, shown]);

  const highlightRow = useCallback((index: number) => {
    const row = rows[index];
    if (row) setHighlight({ query: closeKey, key: row.key });
  }, [closeKey, rows]);

  return {
    listId,
    /** What the box asks about (searchTypeaheadQuery of its text), or null. */
    query,
    /** The list is drawn. */
    shown,
    /** What is drawn is the answer to the text before this one: this text's is on its way. */
    stale: shown && stale,
    /** The list is changing or has just changed: stale, or a row moved a moment ago and takes no press yet. */
    busy: shown && (stale || settling),
    /** The keys of the rows that moved a moment ago and take no press yet. Drawn as every other row (owner, 2026-11-16). */
    settlingRows,
    sections,
    rows,
    /**
     * The models and tools the answer on hand names, drawn or not: a box over results that draw
     * them leaves them out of its list (`offer`), and the page still wants their pictures.
     */
    answerEntities: answer?.response?.entities ?? NO_ENTITIES,
    activeIndex,
    activeOptionId,
    /** For a polite live region: "5 suggestions" once this text's list has stood for a pause, nothing once it is gone. */
    status,
    onKeyDown,
    pick,
    press,
    highlightRow,
    close,
    closeFor,
    reopen,
  };
}

export function searchTypeaheadOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}
