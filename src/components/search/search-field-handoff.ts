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
 */
const HANDOFF_MS = 10_000;

let markedAt: number | null = null;

export function markSearchFieldHandoff(now: number = Date.now()): void {
  markedAt = now;
}

/** Whether a hand-off is waiting, without taking it: safe to call twice in one render. */
export function searchFieldHandoffPending(now: number = Date.now()): boolean {
  return markedAt !== null && now - markedAt <= HANDOFF_MS;
}

export function clearSearchFieldHandoff(): void {
  markedAt = null;
}
