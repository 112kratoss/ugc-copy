/**
 * The top bar's field hands the focus on to the search page's.
 *
 * A search sent from the top bar (Enter, or a row that opens the search page)
 * navigates to /search, where the bar gives way to the page's own field, and
 * the focus went with the bar's field: the page opened with the focus on
 * nothing, so refining the search took a click (search UX audit, 2026-11-13,
 * finding 14). The bar marks the hand-off as it leaves; the page reads it as
 * it mounts and puts the focus in its own field, with the typeahead closed
 * for the text it arrived with: that search is committed, and its list does
 * not stand over its results.
 *
 * A mark lives in this tab's memory only (a client navigation keeps it), and
 * for a few seconds: a leave the person cancels does not focus a later visit.
 *
 * The mark also says how the bar's search was entered (typed and sent with
 * Enter, a completion, a recent search, a model or tool row), which the search
 * page tells the search log with the search it opens on (search-open-log.ts):
 * without it every search from the bar would read as an address opened.
 */
import type { SearchEntry } from '../../../ugc-mobile/lib/public-search-policy/search-open-log';

const HANDOFF_MS = 10_000;

let markedAt: number | null = null;
let markedEntry: SearchEntry = 'typed';

export function markSearchFieldHandoff(now: number = Date.now(), entry: SearchEntry = 'typed'): void {
  markedAt = now;
  markedEntry = entry;
}

/** How the search the bar handed over was entered; read while a hand-off is pending. */
export function searchFieldHandoffEntry(): SearchEntry {
  return markedEntry;
}

/** Whether a hand-off is waiting, without taking it: safe to call twice in one render. */
export function searchFieldHandoffPending(now: number = Date.now()): boolean {
  return markedAt !== null && now - markedAt <= HANDOFF_MS;
}

export function clearSearchFieldHandoff(): void {
  markedAt = null;
}
