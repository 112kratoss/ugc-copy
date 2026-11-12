import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, type MagicbookletApiClient } from '@/lib/api-client';
import {
  SEARCH_TYPEAHEAD_DEBOUNCE_MS,
  isSearchTypeaheadShown,
  parseSearchSuggestResponse,
  searchTypeaheadAction,
  searchTypeaheadQuery,
  searchTypeaheadRows,
  searchTypeaheadSections,
  searchTypeaheadStatus,
  type SearchSuggestResponse,
  type SearchTypeaheadAction,
  type SearchTypeaheadRow,
} from '@/lib/public-search-policy/search-typeahead';

// What a request found for a query: null for one that failed, was refused or
// could not be read, which is drawn as nothing.
type TypeaheadAnswer = { query: string; response: SearchSuggestResponse | null };

// Answers kept while the search is open, so deleting a letter redraws the
// list it had without asking again. Only real answers are kept.
const KEPT_ANSWERS = 30;

/**
 * The typeahead of the search field: what to ask and when, and which answer
 * may be drawn. The rules are the search clients' shared ones
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
  const [answer, setAnswer] = useState<TypeaheadAnswer | null>(null);
  // The query the list was closed for: the Search key, or a row chosen.
  const [closedQuery, setClosedQuery] = useState<string | null>(null);
  const kept = useRef(new Map<string, SearchSuggestResponse>());
  const keptFor = useRef(viewerKey);
  // A 429 names how long the limit lasts: nothing is asked until then.
  const refusedUntil = useRef(0);

  useEffect(() => {
    // An answer says whom its viewer follows and leaves out whom they are
    // blocked with: it is one account's, and goes when the account does.
    if (keptFor.current !== viewerKey) {
      keptFor.current = viewerKey;
      kept.current.clear();
      setAnswer(null);
    }
    if (!active || query === null) return;
    const keptAnswer = kept.current.get(query);
    if (keptAnswer) {
      setAnswer({ query, response: keptAnswer });
      return;
    }
    if (Date.now() < refusedUntil.current) return;
    // One request in flight at most: the pause before it is cancelled by the
    // next keystroke, and so is the request itself.
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
        kept.current.set(query, response);
        if (kept.current.size > KEPT_ANSWERS) {
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

  // A close belongs to the text it was made on: once the field holds another,
  // it is forgotten, so the same text typed again later is offered its list.
  // Adjusted while rendering, as React asks of state that follows a value:
  // an effect would draw the stale close for a frame first.
  const [closedCheckedFor, setClosedCheckedFor] = useState(query);
  if (closedCheckedFor !== query) {
    setClosedCheckedFor(query);
    if (closedQuery !== null && closedQuery !== query) setClosedQuery(null);
  }

  // An answer is drawn only for the text the field holds now: one for an earlier text is nothing.
  const currentResponse = answer !== null && answer.query === query ? answer.response : null;
  const sections = useMemo(() => searchTypeaheadSections(currentResponse, query), [currentResponse, query]);
  const rows = useMemo(() => searchTypeaheadRows(sections), [sections]);
  const shown = isSearchTypeaheadShown({
    focused: active,
    query,
    answerQuery: answer?.query ?? null,
    closedQuery,
    rowCount: rows.length,
  });

  /** The Search key: the search is what is typed, and the list gets out of its way. */
  const close = useCallback(() => setClosedQuery(query), [query]);

  /** A row was chosen: what to do, with the list closed for the text the field will then hold. */
  const pick = useCallback((row: SearchTypeaheadRow): SearchTypeaheadAction => {
    const action = searchTypeaheadAction(row);
    setClosedQuery(action.type === 'search' ? searchTypeaheadQuery(action.query) : query);
    return action;
  }, [query]);

  return {
    /** The list is drawn. */
    shown,
    sections,
    /** For a screen reader: "5 suggestions" while the list is drawn, nothing otherwise. */
    status: shown ? searchTypeaheadStatus(rows.length) : '',
    close,
    pick,
  };
}
