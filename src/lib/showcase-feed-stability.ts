type FeedItemWithId = {
  id: string;
};

/**
 * Keeps the cards a viewer can already see in place while a ranked feed session
 * is established in the background. New results retain their ranked order below
 * the visible prefix, and duplicate posts are removed.
 *
 * A visible card the incoming page also holds is given the incoming copy, in
 * its place: that copy carries the new session's delivery (and the viewer's
 * saved state), and the card drawn from a page built for everyone has neither,
 * so its impression, open and share were never sent. A visible card the
 * incoming page lacks stays as it was.
 */
export function mergeShowcaseFeedKeepingVisibleItems<TItem extends FeedItemWithId>(
  currentItems: TItem[],
  incomingItems: TItem[],
  visibleItemCount: number,
): TItem[] {
  const boundedVisibleItemCount = Number.isFinite(visibleItemCount)
    ? Math.min(currentItems.length, Math.max(0, Math.trunc(visibleItemCount)))
    : 0;
  const incomingItemsById = new Map<string, TItem>();
  for (const item of incomingItems) {
    if (!incomingItemsById.has(item.id)) {
      incomingItemsById.set(item.id, item);
    }
  }
  const mergedItems: TItem[] = [];
  const seenItemIds = new Set<string>();

  for (const item of currentItems.slice(0, boundedVisibleItemCount)) {
    if (!seenItemIds.has(item.id)) {
      seenItemIds.add(item.id);
      mergedItems.push(incomingItemsById.get(item.id) ?? item);
    }
  }

  for (const item of incomingItems) {
    if (!seenItemIds.has(item.id)) {
      seenItemIds.add(item.id);
      mergedItems.push(item);
    }
  }

  return mergedItems;
}
