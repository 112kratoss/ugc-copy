/**
 * The remix openings that have started from their source.
 *
 * Opening a remix shows the post as its creator made it, as the web's creators do (owner,
 * 2026-11-04). An opening is one navigation to a remix creator, named by its route's key, whatever
 * led there: a Remix tap on any screen, Recreate, a link, the start answer's own link. Its first load
 * drops a session an earlier opening saved and restores the source. After that, the session is the
 * opening's own: a creator keyed afresh on the same route (a new identity's screen) and effects that
 * run again (Fast Refresh, a hidden `<Activity>` shown) read what it saved, edits included.
 *
 * Kept in memory, apart from the screen's module, so an edit to the screen does not forget them.
 */
const started = new Set<string>();

/** Openings remembered at most: one evicted while its creator is still open would restore its source once more. */
const OPENINGS_KEPT = 64;

/** True the first time an opening asks for a remix session (`remixDraftScope`), false every time after. */
export function claimRemixFreshStart(opening: string, scope: string): boolean {
  const key = JSON.stringify([opening, scope]);
  if (started.has(key)) return false;
  started.add(key);
  if (started.size > OPENINGS_KEPT) {
    const oldest = started.values().next().value;
    if (oldest !== undefined) started.delete(oldest);
  }
  return true;
}
