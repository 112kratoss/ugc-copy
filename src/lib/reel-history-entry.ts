// A reel opened from a tile pushes a history entry of its own over the page's,
// and its close goes Back to the page's entry; a reel opened by address (a
// shared link) closes by replacing its entry instead. The reels told the two
// apart by the address, where every entry naming a post looks the same: Forward
// onto a reel's own entry, Back onto it from a page the reel linked to (the page
// mounts again) or a reload made its close replace that entry, which left the
// page twice in history, and the next Back stayed on it.
//
// So the entry says itself that the page pushed it, in `history.state`, and a
// page reads it whenever it arrives on an entry: when it mounts and on popstate.
// Next keeps an app's own fields there: its patched pushState and replaceState
// write Next's two fields into the object they are given
// (`copyNextJsInternalHistoryState` in next/dist/client/components/app-router.js),
// and the router's own write after a restore, a Back or Forward, or a reload
// spreads the entry's state (`preserveCustomHistoryState`). Next writes a state
// without them where it navigates or refreshes the entry itself (a link,
// `router.push` or `replace`, `router.refresh()`, a retry after a stale answer,
// a dev server's refresh after a file is saved). The reels' pages do none of
// these while a reel is open, and an entry left unmarked closes as one opened
// by address, as before.

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

function readReelEntryParam(state: unknown): ReelEntryParam | null {
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

/** The history mode of the entry the page is on, for a page that mounts on it. */
export function readCurrentReelHistoryMode(param: ReelEntryParam): ReelHistoryMode {
  return readReelHistoryMode(param, new URLSearchParams(window.location.search), window.history.state);
}

/** Pushes an entry for `url`: the page's own for what `pushedFor` names, or a plain one (a tab's) for null. */
export function pushReelEntry(pushedFor: ReelEntryParam | null, url: string): void {
  window.history.pushState(pushedFor ? createReelEntryState(pushedFor) : null, '', url);
}

/**
 * Replaces the entry the page is on with `url`. An entry the page pushed stays
 * its own while `url` still names what it was pushed for (another post of the
 * reel, another slide), and is a plain entry again once it does not. Never the
 * current state passed through: it carries Next's fields.
 */
export function replaceReelEntry(url: string): void {
  const param = readReelEntryParam(window.history.state);
  const stillNamed = param !== null && new URL(url, window.location.href).searchParams.get(param);
  window.history.replaceState(param && stillNamed ? createReelEntryState(param) : null, '', url);
}
