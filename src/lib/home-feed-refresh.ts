/**
 * Home's feed fetched afresh from page one, asked for by the shell: Home, or the brand beside
 * it, pressed on Home already at its top, as a feed tapped at its top refreshes on X and
 * Instagram (2026-11-15). Pressed on a scrolled Home, they only bring it to its top.
 *
 * A page event, as the top-up sheet is opened (`credit-top-up.ts`): the shell and the feed are
 * separate trees, and the shell needs no handle on the feed. A Home whose feed has not mounted
 * takes no request, and nothing happens.
 */

const REFRESH_EVENT = 'home-feed:refresh';

/** Asks Home's feed to fetch its lane afresh from page one. */
export function requestHomeFeedRefresh() {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/** Takes the shell's refresh requests, for the feed. Returns what stops taking them. */
export function onHomeFeedRefresh(refresh: () => void) {
  const take = () => refresh();
  window.addEventListener(REFRESH_EVENT, take);
  return () => window.removeEventListener(REFRESH_EVENT, take);
}
