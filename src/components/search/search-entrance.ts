/**
 * How the search page opens out of the control that was pressed, as the app's
 * search does (owner, 2026-11-15: "match the app"; the app's own is
 * `ugc-mobile/lib/search-entrance.ts`, after iOS's home-screen Search). The
 * field's capsule grows out of the pressed control into the page's field, its
 * magnifier travels with it, its text arrives or travels too, and the rest of
 * the screen cross-fades; leaving the page runs it back into the control.
 *
 * The web draws it with the browser's View Transitions API through React's
 * `<ViewTransition>` (SearchEntrancePart.tsx): every control that opens search
 * and the page's own field name their parts, and a navigation between the two
 * morphs each part into its pair. The CSS beside `.app-shell-search` in
 * globals.css sets the timing. A browser without the API navigates as before,
 * and reduced motion runs none of it.
 *
 * This module is the pure part: which control was pressed, the names and
 * classes each part carries, and the app's timing.
 */

/**
 * The control a search opens from: the top bar's field (from 1024px), the top
 * bar's round magnifier (below it), or Explore's search bar (below it).
 */
export type SearchEntranceOrigin = 'bar' | 'button' | 'entry';

/** The parts that travel: the capsule itself, its magnifier, its text and its clear button. */
export type SearchEntrancePart = 'capsule' | 'icon' | 'text' | 'clear';

/** Which end of the motion a part is drawn at: a control that opens search, or the search page's field. */
export type SearchEntranceSide = 'control' | 'field';

export const SEARCH_ENTRANCE = {
  /** The screen's cross-fade (the app's navigator fade). */
  fadeMs: 200,
  /** The capsule's growth, on a decelerating curve with no tail. */
  growMs: 300,
  growEasing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /**
   * The field takes the focus two frames after the growth lands, as the app's
   * does: a focus during it would draw the caret and the focus ring on a
   * capsule still growing, and on a phone raise the keyboard under it.
   */
  focusAfterMs: 330,
  /** Close: back into the control, quicker than the growth. */
  exitMs: 150,
  exitEasing: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
} as const;

/**
 * The press marks which control it was, and the search page reads it as it
 * mounts, in the same navigation: its field takes that control's names, so the
 * two pair. In this tab's memory only, and for a few seconds: a navigation the
 * person gives up does not grow a later visit out of the control.
 */
const PENDING_MS = 10_000;

let marked: { origin: SearchEntranceOrigin; at: number } | null = null;

export function markSearchEntrance(origin: SearchEntranceOrigin, now: number = Date.now()): void {
  marked = { origin, at: now };
}

/** The control a search is opening from, if one was pressed just now; not taken, so a render may run twice. */
export function searchEntrancePending(now: number = Date.now()): SearchEntranceOrigin | null {
  return marked !== null && now - marked.at <= PENDING_MS ? marked.origin : null;
}

export function clearSearchEntrance(): void {
  marked = null;
}

/**
 * A plain press of a link that opens search: the left button, no modifier.
 * One that opens a new tab or window leaves this page as it is, so nothing is marked.
 */
export function isPlainPress(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The props of React's `<ViewTransition>` a part is drawn with. */
export type SearchEntranceTransition = {
  name: string;
  share: string;
  default: 'none';
};

/**
 * A part's view-transition name and classes. The name says which control it
 * belongs to, so the page's field pairs with the one control that was pressed
 * and every other control on screen stays out of the motion.
 *
 * Each side carries the class of the direction it arrives in, since a
 * transition reads its classes from the element it lands on: the field's are
 * the opening's (`search-open-*`), a control's the closing's
 * (`search-close-*`). Nothing animates a part on its own (`default: 'none'`):
 * React names a part that arrives or leaves in a navigation only when it has
 * a pair on the other side (an unpaired one is drawn with the screen's
 * cross-fade, where it does not travel). So every control draws each part,
 * with an unseen stand-in for one it has no use for (the round magnifier's
 * words, a clear button while it holds no text: SearchEntranceStandIn), and
 * the field's words and clear button always travel into it.
 */
export function searchEntranceTransition(
  origin: SearchEntranceOrigin,
  part: SearchEntrancePart,
  side: SearchEntranceSide,
): SearchEntranceTransition {
  return {
    name: `search-${origin}-${part}`,
    share: `search-${side === 'field' ? 'open' : 'close'}-${part}`,
    default: 'none',
  };
}

/**
 * Whether the opening will move here: the browser has view transitions and the
 * person has not asked for reduced motion. Read on the client only.
 */
export function searchEntranceMoves(): boolean {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') return false;
  return !(typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
