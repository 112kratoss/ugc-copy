// A reel opened from a tile pushes a history entry of its own over the page's,
// and its close goes Back to the page's entry; a reel opened by address (a
// shared link) closes by replacing its entry instead. Once the browser's Back
// or Forward had reached an entry, the reels told the two apart by the address
// alone, where every entry naming a post looks the same: Forward onto a reel's
// own entry made its close replace that entry, which left the page twice in
// history, and the next Back stayed on it.
//
// So the entry says itself that the page pushed it, in `history.state`. Next
// keeps an app's own fields there: its patched pushState and replaceState write
// Next's two fields into the object they are given
// (`copyNextJsInternalHistoryState` in next/dist/client/components/app-router.js),
// and the router's own write after them spreads the entry's state
// (`preserveCustomHistoryState`). Only a navigation of the router's own, a link
// or `router.refresh()`, writes a state without them.

/** How a reel's close leaves history: Back to the entry under its own, or by replacing the entry it was opened on. */
export type ReelHistoryMode = 'pushed' | 'direct' | null;

/** The address parameter an entry was pushed to open: a post's reel, or the profile's creation viewer. */
export type ReelEntryParam = 'post' | 'generation';

const PUSHED_FOR_KEY = 'reelPushedFor';

/**
 * The state for an entry pushed to open what `param` names. A new object each
 * time: Next writes its own fields into the object it is given, and takes an
 * object that already carries them for one of its own writes.
 */
export function createReelEntryState(param: ReelEntryParam): Record<string, ReelEntryParam> {
  return { [PUSHED_FOR_KEY]: param };
}

/** What the entry with this state was pushed to open; null for an entry the page did not push. */
export function readReelEntryParam(state: unknown): ReelEntryParam | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[PUSHED_FOR_KEY];
  return value === 'post' || value === 'generation' ? value : null;
}

/**
 * The history mode of an entry for what `param` names in its address: pushed
 * when the page pushed the entry to open it, direct when the address names one
 * anyway (a shared link, or an entry from before the reels marked theirs), null
 * when it names none.
 */
export function readReelHistoryMode(param: ReelEntryParam, search: URLSearchParams, state: unknown): ReelHistoryMode {
  if (!search.get(param)) return null;
  return readReelEntryParam(state) === param ? 'pushed' : 'direct';
}

/**
 * The state for replacing the entry the page is on with an address of
 * `nextSearch`: an entry the page pushed stays the page's own while the address
 * still names what it was pushed for (another post of the reel, another slide),
 * and is a plain entry again once it does not.
 */
export function keepReelEntryState(state: unknown, nextSearch: URLSearchParams): Record<string, ReelEntryParam> | null {
  const param = readReelEntryParam(state);
  return param && nextSearch.get(param) ? createReelEntryState(param) : null;
}
