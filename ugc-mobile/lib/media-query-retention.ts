import type { QueryClient } from '@tanstack/react-query';

/** Extra media retained for quick return, beyond mounted screens/viewers. */
export const INACTIVE_MEDIA_QUERY_LIMIT = 6;
export const INACTIVE_MEDIA_ITEM_LIMIT = 240;
const MEDIA_QUERIES = new Set([
  'showcase-feed', 'showcase-post', 'immersive-preview-source',
  'profile-generations', 'profile-owner-posts', 'profile-saved-media',
  'profile-library-selection',
]);

function itemCount(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const data = value as Record<string, unknown>;
  if (Array.isArray(data.pages)) return data.pages.reduce((sum, page) => sum + itemCount(page), 0);
  let count = 0;
  for (const field of ['items', 'posts', 'generations', 'showcaseItems', 'ownerPosts']) {
    if (Array.isArray(data[field])) count += data[field].length;
  }
  return count || (data.item || data.post ? 1 : 0);
}

/**
 * Evict whole inactive snapshots, never trim pages from a mounted list. A
 * disabled observer still owns its data (for example, a viewer during zoom).
 * Fetches also retain ownership until they settle. This preserves scroll,
 * continuation cursors and the selected viewer item together.
 */
export function pruneInactiveMediaQueries(client: QueryClient, memoryPressure = false): void {
  const candidates = client.getQueryCache().getAll().filter((query) => (
    MEDIA_QUERIES.has(String(query.queryKey[0]))
    && query.getObserversCount() === 0
    && query.state.fetchStatus === 'idle'
  )).sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  let retainedQueries = 0;
  let retainedItems = 0;
  for (const query of candidates) {
    const count = itemCount(query.state.data);
    if (memoryPressure || retainedQueries >= INACTIVE_MEDIA_QUERY_LIMIT || retainedItems + count > INACTIVE_MEDIA_ITEM_LIMIT) {
      client.getQueryCache().remove(query);
    } else {
      retainedQueries += 1;
      retainedItems += count;
    }
  }
}

export function installMediaQueryRetention(client: QueryClient): () => void {
  let scheduled = false;
  let disposed = false;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' && event.type !== 'observerRemoved') return;
    if (!MEDIA_QUERIES.has(String(event.query.queryKey[0])) || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) pruneInactiveMediaQueries(client);
    });
  });
  return () => { disposed = true; unsubscribe(); };
}
