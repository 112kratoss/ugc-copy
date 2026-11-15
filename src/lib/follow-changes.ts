/**
 * The follows and unfollows a viewer made in this tab, by creator: what a
 * page that Back restores reads to say "Following" of a creator followed
 * since its answer was kept.
 *
 * A search page restored by Back draws the answer it kept and asks nothing
 * again (search-kept-pages.ts), so a creator followed from one of its rows,
 * or on the creator's own page, the post page or the reel, came back reading
 * "Follow" (review of #828, known and left; owner's brief 2026-11-16). Every
 * place that confirms a follow with the server writes it here; the search
 * page reads it once, as it is restored.
 *
 * Kept in this tab's sessionStorage, under the account that made the changes:
 * a read by another account, or by nobody, finds nothing. Guarded like the
 * recent searches: a browser with storage switched off keeps nothing, and
 * everything works as before.
 */

const KEY = 'magicbooklet:follow-changes:v1';
const MAX_CHANGES = 200;

type Kept = { viewerId: string; byId: Record<string, boolean> };

function read(): Kept | null {
  try {
    const raw = typeof window === 'undefined' ? null : window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const { viewerId, byId } = value as { viewerId?: unknown; byId?: unknown };
    if (typeof viewerId !== 'string' || typeof byId !== 'object' || byId === null || Array.isArray(byId)) return null;
    const changes: Record<string, boolean> = {};
    for (const [creatorId, following] of Object.entries(byId as Record<string, unknown>)) {
      if (typeof following === 'boolean') changes[creatorId] = following;
    }
    return { viewerId, byId: changes };
  } catch {
    return null;
  }
}

/** A follow or unfollow the server confirmed for this account. */
export function noteFollowChange(viewerId: string | null | undefined, creatorId: string, following: boolean): void {
  if (!viewerId || !creatorId) return;
  try {
    const kept = read();
    const byId = kept && kept.viewerId === viewerId ? { ...kept.byId } : {};
    // The newest change last, so the oldest is the one dropped past the cap.
    delete byId[creatorId];
    byId[creatorId] = following;
    const ids = Object.keys(byId);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CHANGES))) delete byId[id];
    window.sessionStorage.setItem(KEY, JSON.stringify({ viewerId, byId }));
  } catch {
    // Not kept: a page Back restores reads the state its answer had.
  }
}

/** This account's changes in this tab, by creator id; nothing for another account or a visitor. */
export function readFollowChanges(viewerId: string | null | undefined): Readonly<Record<string, boolean>> {
  if (!viewerId) return {};
  const kept = read();
  return kept && kept.viewerId === viewerId ? kept.byId : {};
}
