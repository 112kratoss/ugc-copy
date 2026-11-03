const pendingByOwner = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * One request per owner and key while it is on the wire: a caller that asks
 * during the first request shares its promise.
 *
 * Opening a creation twice in quick succession — a double tap, or the card feed
 * and the reel mounting back to back — used to send the same library read once
 * per screen (2026-09-16 Creations reliability audit, C4).
 *
 * Nothing is cached. The entry is dropped when the request settles, whether it
 * succeeded or failed, so the next caller always gets a fresh read.
 */
export function dedupeInFlight<T>(owner: object, key: string, load: () => Promise<T>): Promise<T> {
  const existing = pendingByOwner.get(owner)?.get(key) as Promise<T> | undefined;
  return existing ?? trackInFlight(owner, key, load());
}

/**
 * Records a request under its owner and key while it is on the wire, without
 * sharing it: for a request every caller has to send for itself, which others
 * only need to know is under way (`isInFlight`). Dropped when it settles,
 * whether it succeeded or failed.
 */
export function trackInFlight<T>(owner: object, key: string, request: Promise<T>): Promise<T> {
  let pending = pendingByOwner.get(owner);
  if (!pending) {
    pending = new Map();
    pendingByOwner.set(owner, pending);
  }

  const bucket = pending;
  bucket.set(key, request);
  const release = () => {
    if (bucket.get(key) === request) bucket.delete(key);
  };
  // Both branches handled here, so a rejection is never reported as unhandled
  // on this derived promise; callers still receive it on `request`.
  request.then(release, release);
  return request;
}

/** Whether a request for this owner and key is on the wire. */
export function isInFlight(owner: object, key: string) {
  return pendingByOwner.get(owner)?.has(key) ?? false;
}
