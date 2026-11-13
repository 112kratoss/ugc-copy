import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ApiError, type MagicbookletApiClient } from '@/lib/api-client';
import { searchTypingAppendedFrom, searchTypingHeldLength, type SearchTypingHeld } from '@/lib/search-typing-mode';
import {
  SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS,
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  SEARCH_TYPEAHEAD_KEPT_ANSWERS,
  SEARCH_TYPEAHEAD_KEPT_ANSWER_MS,
  SEARCH_TYPEAHEAD_OFFER_ALL,
  SEARCH_TYPEAHEAD_PRESS_SETTLE_MS,
  isSearchTypeaheadPressAccepted,
  isSearchTypeaheadShown,
  parseSearchSuggestResponse,
  placeSearchTypeaheadRows,
  searchTypeaheadAction,
  searchTypeaheadAsks,
  searchTypeaheadDrawn,
  searchTypeaheadQuery,
  searchTypeaheadRows,
  searchTypeaheadStatus,
  searchTypeaheadUnsettledRows,
  searchTypingSections,
  type SearchSuggestResponse,
  type SearchTypeaheadAction,
  type SearchTypeaheadAnswer,
  type SearchTypeaheadPlacement,
  type SearchTypeaheadRow,
} from '@/lib/public-search-policy/search-typeahead';

// An answer kept so that deleting a letter redraws the list it had without
// asking again. Only real answers are kept, only while the field keeps the
// focus, and none is drawn again once it is older than
// SEARCH_TYPEAHEAD_KEPT_ANSWER_MS: an answer says whom the viewer follows and
// leaves out whom they are blocked with, and both change on other screens.
type KeptAnswer = { response: SearchSuggestResponse; at: number };

// No row is settling: one array, so a panel that has settled keeps its props.
const NO_ROWS: readonly string[] = [];

/**
 * The typeahead of the search field: what to ask and when, and what is drawn
 * while an answer is on its way. The rules are the search clients' shared ones
 * (`lib/public-search-policy/search-typeahead.ts`), the web's search page
 * follows the same; this is the app's timer and request around them.
 *
 * `active` is the search open and in its typing mode (`lib/search-typing-mode.ts`):
 * from the moment the field takes the focus or is typed in until the person
 * commits a search. The list is drawn *in place of* results for that whole
 * time, the keyboard put away by a drag included, and nothing is asked or
 * drawn otherwise. It is the "Search for" row, the recent searches the text
 * begins (`history`), then the answer's sections (searchTypingSections).
 */
export function useSearchTypeahead({ api, text, active, viewerKey, history, runs }: {
  api: MagicbookletApiClient;
  /** What the field holds. */
  text: string;
  active: boolean;
  /** Whose answers these are: another account's are not drawn for this one. */
  viewerKey: string | null;
  /** The recent searches kept on this device, newest first. */
  history: readonly string[];
  /**
   * Whether a commit of this text would be searched (the picked tab's
   * minimum length): "Search for" and a recent search are offered only then.
   */
  runs: (text: string) => boolean;
}) {
  const query = useMemo(() => searchTypeaheadQuery(text), [text]);
  const [answer, setAnswer] = useState<SearchTypeaheadAnswer | null>(null);
  const kept = useRef(new Map<string, KeptAnswer>());
  const keptFor = useRef(viewerKey);
  // A 429 names how long the limit lasts: nothing is asked until then.
  const refusedUntil = useRef(0);

  useEffect(() => {
    // An answer says whom its viewer follows and leaves out whom they are
    // blocked with: it is one account's, and goes when the account does.
    if (keptFor.current !== viewerKey) {
      keptFor.current = viewerKey;
      kept.current.clear();
    }
    if (!active) {
      // Kept for one focus of the field: what is typed after coming back is asked again.
      kept.current.clear();
      return;
    }
    if (query === null || !searchTypeaheadAsks(query, SEARCH_TYPEAHEAD_OFFER_ALL)) return;
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
    // next keystroke, and so is the request itself. An account change ends it
    // too (`viewerKey`), so an answer asked as the account before is dropped.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      let response: SearchSuggestResponse | null = null;
      try {
        response = parseSearchSuggestResponse(await api.suggestSearch({ query }, controller.signal));
      } catch (error) {
        // A suggestion is an extra: its failure is nothing, never a message.
        if (error instanceof ApiError && error.status === 429) {
          const details = error.details as { retryAfterSeconds?: unknown } | null | undefined;
          const seconds = typeof details?.retryAfterSeconds === 'number' && details.retryAfterSeconds > 0
            ? details.retryAfterSeconds
            : 5;
          refusedUntil.current = Date.now() + Math.min(seconds, 60) * 1000;
        }
      }
      if (controller.signal.aborted) return;
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
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, api, query, viewerKey]);

  // State that follows the field, adjusted while rendering, as React asks of
  // state that follows a value (an effect would draw the stale state for a
  // frame first):
  //   - an answer is kept on show for the text typed after it only (the
  //     shared rule, searchTypeaheadDrawn): it goes when the field is emptied,
  //     when the typing ends, so coming back never draws what was asked
  //     before, and when the account changes.
  const [checkedFor, setCheckedFor] = useState({ active, query, viewerKey });
  if (checkedFor.active !== active || checkedFor.query !== query || checkedFor.viewerKey !== viewerKey) {
    setCheckedFor({ active, query, viewerKey });
    if ((!active || query === null || checkedFor.viewerKey !== viewerKey) && answer !== null) setAnswer(null);
  }

  // This text's answer, or until it arrives the one before it, marked stale,
  // under the rows that need no answer: "Search for" and the recents it begins.
  // A recent search too short for the picked tab is not offered: pressed, it would search nothing.
  const runningHistory = useMemo(() => history.filter((item) => runs(item)), [history, runs]);
  const drawn = useMemo(
    () => searchTypeaheadDrawn(answer, query, { recents: runningHistory, offer: SEARCH_TYPEAHEAD_OFFER_ALL }),
    [answer, query, runningHistory],
  );
  const stale = drawn.stale;
  const searchable = query !== null && runs(query);
  const sections = useMemo(
    () => searchTypingSections({ query, sections: drawn.sections, searchable }),
    [drawn.sections, query, searchable],
  );
  const rows = useMemo(() => searchTypeaheadRows(sections), [sections]);
  // The list is the typing screen: never closed while the typing lasts.
  const shown = isSearchTypeaheadShown({ focused: active, query, closedQuery: null, rowCount: rows.length });

  const placement = useRef<SearchTypeaheadPlacement | null>(null);
  // The places rows have stood in lately (searchTypingHeldLength): a row an
  // answer adds there is no row added under the list.
  const held = useRef<SearchTypingHeld | null>(null);
  // The rows' places, kept as they are drawn (the shared rule,
  // placeSearchTypeaheadRows): a row that has just come to stand where it is
  // takes no press for a moment, so a press aimed at the row before it does
  // not open this one. Kept in a layout effect, which React runs inside the
  // commit that draws the rows: no press reaches this with the rows drawn in
  // places it has not recorded. (A passive effect may run later than the
  // commit when the change came from an answer arriving, and a press handled
  // in between was judged by the places before: a row that had only just
  // moved under the finger took it.)
  useLayoutEffect(() => {
    if (!shown) {
      placement.current = null;
      held.current = null;
      return;
    }
    const now = Date.now();
    const before = placement.current;
    const next = new Map(placeSearchTypeaheadRows(before, rows, now));
    const beforeOrder = before ? [...before.entries()].sort((a, b) => a[1].index - b[1].index).map(([key]) => key) : [];
    const keys = rows.map((row) => row.key);
    const changed = before === null || beforeOrder.length !== keys.length || beforeOrder.some((key, index) => keys[index] !== key);
    if (changed) held.current = searchTypingHeldLength(before === null ? null : held.current, beforeOrder.length, now);
    // Rows only added under the list as it stood, where no row has stood
    // lately: nothing was there to aim at (searchTypingAppendedFrom), so they
    // take a press at once.
    const appendedFrom = before ? searchTypingAppendedFrom(beforeOrder, keys, held.current?.length) : null;
    if (appendedFrom !== null) {
      for (const [key, place] of next) {
        if (place.index >= appendedFrom) next.set(key, { index: place.index, since: Number.NEGATIVE_INFINITY });
      }
    }
    placement.current = next;
  }, [rows, shown]);

  // What the panel shows of that moment: the rows that do not take a press
  // yet (the shared rule, searchTypeaheadUnsettledRows), drawn dimmed, and the
  // panel busy, as it is while its rows are stale. From a change of the order
  // on show that moved a row until the order has stood for the same time (a
  // little longer than the press rule asks of a row an earlier change moved).
  // A list that comes on show has nothing to settle, and neither has a change
  // that moves no row. Adjusted while rendering, as the answer above is.
  const rowOrder = useMemo(() => rows.map((row) => row.key).join('\n'), [rows]);
  const drawnOrder = shown ? rowOrder : null;
  // `held` and `stood` are the press rule's record of places rows have stood
  // in lately (searchTypingHeldLength), kept by the order rather than the
  // clock: held until the order has stood still for the settle time.
  const [order, setOrder] = useState<{ drawn: string | null; unsettled: readonly string[]; held: number; stood: boolean }>({
    drawn: null, unsettled: NO_ROWS, held: 0, stood: true,
  });
  if (order.drawn !== drawnOrder) {
    const beforeOrder = order.drawn === null ? [] : order.drawn.split('\n');
    const keys = rows.map((row) => row.key);
    const heldLength = order.drawn === null || order.stood ? beforeOrder.length : Math.max(order.held, beforeOrder.length);
    const appendedFrom = searchTypingAppendedFrom(beforeOrder, keys, heldLength);
    setOrder({
      drawn: drawnOrder,
      unsettled: order.drawn === null || drawnOrder === null
        ? NO_ROWS
        : searchTypeaheadUnsettledRows({ order: beforeOrder, unsettled: order.unsettled }, keys)
          .filter((key) => appendedFrom === null || keys.indexOf(key) < appendedFrom),
      held: heldLength,
      stood: false,
    });
  }
  const settlingRows = shown && order.drawn === drawnOrder ? order.unsettled : NO_ROWS;
  const settling = settlingRows.length > 0;
  const standing = shown && order.drawn === drawnOrder && !order.stood;
  useEffect(() => {
    if (!settling && !standing) return;
    const timer = setTimeout(() => {
      setOrder((current) => (current.drawn === rowOrder ? { ...current, unsettled: NO_ROWS, stood: true } : current));
    }, SEARCH_TYPEAHEAD_PRESS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [rowOrder, settling, standing]);

  // What a screen reader is told: the count of this text's own list, once it
  // has stood for a pause in typing. A stale list changes nothing, so the
  // count is said when it changes and at most once per pause. Only the
  // answer's rows count: "Search for" and the recents are there for any text,
  // and an answer with nothing in it is no "1 suggestion".
  const [status, setStatus] = useState('');
  const rowCount = rows.filter((row) => row.kind !== 'search' && !(row.kind === 'completion' && row.recent)).length;
  useEffect(() => {
    if (shown && stale) return;
    const next = shown ? searchTypeaheadStatus(rowCount) : '';
    const timer = setTimeout(() => setStatus(next), SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [rowCount, shown, stale]);

  /**
   * A row was pressed: what to do; or null for a press that does not count,
   * because the row has only just come to stand under the finger
   * (isSearchTypeaheadPressAccepted). What ends the typing is the screen's to
   * say (a creator's profile leaves it as it is).
   */
  const press = useCallback((row: SearchTypeaheadRow): SearchTypeaheadAction | null => {
    if (!isSearchTypeaheadPressAccepted(placement.current, row.key, Date.now())) return null;
    return searchTypeaheadAction(row);
  }, []);

  return {
    /** The list is drawn. */
    shown,
    /** The panel is changing or has just changed: its rows are the text before's, or one moved a moment ago and takes no press yet. */
    busy: shown && (stale || settling),
    /** The keys of the rows that moved a moment ago and take no press yet: drawn dimmed. */
    settlingRows,
    sections,
    /** For a screen reader: "5 suggestions" once this text's list has stood for a pause, nothing once it is gone. */
    status,
    press,
  };
}
