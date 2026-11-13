import { SEARCH_TYPEAHEAD_PRESS_SETTLE_MS, searchTypeaheadQuery } from './public-search-policy/search-typeahead';

/**
 * The app's search has two modes (search UX audit 2026-11-13, finding 1):
 *
 *   - **typing**: from the moment the field takes the focus or is typed in
 *     until the person commits a search. The screen shows suggestions only,
 *     as one list under the tabs ("Search for", recent searches, creators,
 *     models and tools, completions), and asks the server for suggestions
 *     only: no search is sent and no result is drawn. Putting the keyboard
 *     away (a drag of the list) does not end it: the list stays.
 *   - **results**: after a commit: the Search key, the "Search for" row, a
 *     completion, a recent search, a model or tool (Posts narrowed to it), or
 *     a tab pressed with text in the field. Tapping the field again goes back
 *     to typing for the text it holds.
 *
 * A creator row opens the profile and leaves the mode as it is, so coming
 * back finds the list where it was. The web keeps live results as you type;
 * this is the app's own rule.
 */
export type SearchScreenMode = 'typing' | 'results';

export type SearchModeEvent =
  /** The field took the focus (a tap on it, or the screen opening). */
  | 'focus'
  /** The field's text changed: typed, pasted, cleared. */
  | 'edit'
  /** A search was committed. */
  | 'commit';

export function searchModeAfter(_mode: SearchScreenMode, event: SearchModeEvent): SearchScreenMode {
  return event === 'commit' ? 'results' : 'typing';
}

/**
 * What the body of the screen draws:
 *   - `start`: the field asks about nothing (empty, or an `@` alone):
 *     recent searches, and the ideas to start from;
 *   - `suggestions`: the typing list, in place of results;
 *   - `results`: the committed search (its own idle, loading, failure and
 *     empty states included).
 */
export type SearchScreenBody = 'start' | 'suggestions' | 'results';

export function searchScreenBody(state: { mode: SearchScreenMode; text: string }): SearchScreenBody {
  if (searchTypeaheadQuery(state.text) === null) return 'start';
  return state.mode === 'typing' ? 'suggestions' : 'results';
}

/** A search request is sent only for a committed search: typing asks for suggestions alone. */
export function searchAsksForResults(mode: SearchScreenMode): boolean {
  return mode === 'results';
}

/**
 * A tab pressed while typing commits what the field holds, so the tab opens
 * on its results; with nothing to search for it only picks the tab.
 */
export function searchTabPressCommits(state: { mode: SearchScreenMode; text: string }): boolean {
  return state.mode === 'typing' && searchTypeaheadQuery(state.text) !== null;
}

/**
 * Where a typing list only grew at its end into places nothing stood in a
 * moment ago: every row drawn before stands where it stood, and the new rows
 * come after the last of them and after `heldLength`, the most rows the list
 * has drawn since its order last stood still (searchTypingHeldLength).
 * Returns the index from which the new rows stand where nothing stood, or null
 * when anything above moved or every new row fills a place a row has just left.
 *
 * The app's list starts with rows that need no answer ("Search for", the
 * matching recent searches) and an answer then adds rows under them. Where no
 * row has stood for a while there was nothing to aim at (the list is the
 * screen's whole body while typing), so a row appended there takes a press at
 * once and is not drawn dimmed. A row that came between, a row that moved, and
 * a row added where another stood a moment before (a letter shortened the
 * list, then an answer lengthened it again) keep the shared rule
 * (`isSearchTypeaheadPressAccepted`): a finger may be on its way to that place.
 */
export function searchTypingAppendedFrom(
  before: readonly string[],
  order: readonly string[],
  heldLength: number = before.length,
): number | null {
  if (order.length <= before.length) return null;
  if (!before.every((key, index) => order[index] === key)) return null;
  const from = Math.max(before.length, heldLength);
  return from < order.length ? from : null;
}

/** The most rows a typing list has drawn since its order last stood still, and when its order last changed. */
export type SearchTypingHeld = { length: number; changedAt: number };

/**
 * The record searchTypingAppendedFrom reads, after the order changes at `now`
 * from a list of `beforeLength` rows: a place a row stood in counts as held
 * until the order has stood still for SEARCH_TYPEAHEAD_PRESS_SETTLE_MS (as
 * long as the press rule holds a row back). `held` is null when the list was
 * not on show.
 */
export function searchTypingHeldLength(held: SearchTypingHeld | null, beforeLength: number, now: number): SearchTypingHeld {
  const stood = held === null || now - held.changedAt >= SEARCH_TYPEAHEAD_PRESS_SETTLE_MS;
  return { length: stood ? beforeLength : Math.max(held.length, beforeLength), changedAt: now };
}
