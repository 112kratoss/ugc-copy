/**
 * What the viewer took out of the feed on this visit (a block, a Hide, a Not
 * interested, a report), for Home's "Make this" shelf. The shelf is drawn on
 * the server with the viewer's relations of that moment, and the feed below it
 * changes after that; a refresh of the page would also reset the feed's loaded
 * pages, so the feed tells the shelf instead. Kept in memory for the tab, so
 * coming Back to Home (the router's cached page) leaves them out too. It can
 * only hide more: a reload asks the server again, which knows the same and more.
 */

const removedCreatorIds = new Set<string>();
const removedPostIds = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

export function removeFromHomeShelf(removal: { creatorId?: string | null; postId?: string | null }) {
  if (removal.creatorId) removedCreatorIds.add(removal.creatorId);
  if (removal.postId) removedPostIds.add(removal.postId);
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeHomeShelfRemovals(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes whenever something is removed, for `useSyncExternalStore`. */
export function getHomeShelfRemovalsVersion() {
  return version;
}

export function isRemovedFromHomeShelf(card: { postId: string; creatorId: string | null }) {
  return removedPostIds.has(card.postId) || (card.creatorId !== null && removedCreatorIds.has(card.creatorId));
}

export function forgetHomeShelfRemovalsForTests() {
  removedCreatorIds.clear();
  removedPostIds.clear();
  version = 0;
}
