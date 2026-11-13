import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, type MagicbookletApiClient } from '@/lib/api-client';
import {
  SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS,
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  SEARCH_TYPEAHEAD_KEPT_ANSWERS,
  SEARCH_TYPEAHEAD_KEPT_ANSWER_MS,
  SEARCH_TYPEAHEAD_PRESS_SETTLE_MS,
  isSearchTypeaheadPressAccepted,
  isSearchTypeaheadShown,
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
} from '@/lib/public-search-policy/search-typeahead';

// An answer kept so that deleting a letter redraws the list it had without
// asking again. Only real answers are kept, only while the field keeps the
// focus, and none is drawn again once it is older than
// SEARCH_TYPEAHEAD_KEPT_ANSWER_MS: an answer says whom the viewer follows and
// leaves out whom they are blocked with, and both change on other screens.
type KeptAnswer = { response: SearchSuggestResponse; at: number };

/**
 * The typeahead of the search field: what to ask and when, and what is drawn
 * while an answer is on its way. The rules are the search clients' shared ones
 * (`lib/public-search-policy/search-typeahead.ts`), the web's search page
 * follows the same; this is the app's timer and request around them.
 *
 * `active` is the search open with its field focused: nothing is asked or
 * drawn otherwise, so the list goes when the keyboard does and never stands
 * over results the person has scrolled into.
 */
export function useSearchTypeahead({ api, text, active, viewerKey }: {
  api: MagicbookletApiClient;
  /** What the field holds. */
  text: string;
  active: boolean;
  /** Whose answers these are: another account's are not drawn for this one. */
  viewerKey: string | null;
}) {
  const query = useMemo(() => searchTypeaheadQuery(text), [text]);
  const [answer, setAnswer] = useState<SearchTypeaheadAnswer | null>(null);
  // The query the list was closed for: the Search key, or a row chosen.
  const [closedQuery, setClosedQuery] = useState<string | null>(null);
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
  //   - a close belongs to the text it was made on: once the field holds
  //     another, it is forgotten, so the same text typed again later is
  //     offered its list;
  //   - an answer is kept on show for the text typed after it only (the
  //     shared rule, searchTypeaheadDrawn): it goes when the field is emptied,
  //     when the focus leaves, so coming back never draws what was asked
  //     before, and when the account changes.
  const [checkedFor, setCheckedFor] = useState({ active, query, viewerKey });
  if (checkedFor.active !== active || checkedFor.query !== query || checkedFor.viewerKey !== viewerKey) {
    setCheckedFor({ active, query, viewerKey });
    if (closedQuery !== null && closedQuery !== query) setClosedQuery(null);
    if ((!active || query === null || checkedFor.viewerKey !== viewerKey) && answer !== null) setAnswer(null);
  }

  // This text's answer, or until it arrives the one before it, marked stale.
  const { sections, stale } = useMemo(() => searchTypeaheadDrawn(answer, query), [answer, query]);
  const rows = useMemo(() => searchTypeaheadRows(sections), [sections]);
  const shown = isSearchTypeaheadShown({ focused: active, query, closedQuery, rowCount: rows.length });

  const placement = useRef<SearchTypeaheadPlacement | null>(null);
  // The rows' places, kept as they are drawn (the shared rule,
  // placeSearchTypeaheadRows): a row that has just come to stand where it is
  // takes no press for a moment, so a press aimed at the row before it does
  // not open this one. A press handler runs after this effect: React runs
  // pending effects before it handles a press.
  useEffect(() => {
    placement.current = shown ? placeSearchTypeaheadRows(placement.current, rows, Date.now()) : null;
  }, [rows, shown]);

  // The panel says it is busy for that moment, as it does while its rows are
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
    const timer = setTimeout(() => {
      setOrder((current) => (current.drawn === rowOrder ? { drawn: rowOrder, settled: true } : current));
    }, SEARCH_TYPEAHEAD_PRESS_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [rowOrder, settling]);

  // What a screen reader is told: the count of this text's own list, once it
  // has stood for a pause in typing. A stale list changes nothing, so the
  // count is said when it changes and at most once per pause.
  const [status, setStatus] = useState('');
  const rowCount = rows.length;
  useEffect(() => {
    if (shown && stale) return;
    const next = shown ? searchTypeaheadStatus(rowCount) : '';
    const timer = setTimeout(() => setStatus(next), SEARCH_TYPEAHEAD_ANNOUNCE_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [rowCount, shown, stale]);

  /** The Search key: the search is what is typed, and the list gets out of its way. */
  const close = useCallback(() => setClosedQuery(query), [query]);

  /**
   * A row was pressed: what to do, with the list closed for the text the
   * field will then hold; or null for a press that does not count, because
   * the row has only just come to stand under the finger
   * (isSearchTypeaheadPressAccepted).
   */
  const press = useCallback((row: SearchTypeaheadRow): SearchTypeaheadAction | null => {
    if (!isSearchTypeaheadPressAccepted(placement.current, row.key, Date.now())) return null;
    const action = searchTypeaheadAction(row);
    setClosedQuery(action.type === 'search' ? searchTypeaheadQuery(action.query) : query);
    return action;
  }, [query]);

  return {
    /** The list is drawn. */
    shown,
    /** The panel is changing or has just changed: its rows are the text before's, or one moved a moment ago and takes no press yet. */
    busy: shown && (stale || settling),
    sections,
    /** For a screen reader: "5 suggestions" once this text's list has stood for a pause, nothing once it is gone. */
    status,
    close,
    press,
  };
}
