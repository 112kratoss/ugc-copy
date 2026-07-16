type FeedItemWithId = {
  id: string;
};

/**
 * Keeps the cards a viewer can already see in place while a ranked feed session
 * is established in the background. New results retain their ranked order below
 * the visible prefix, and duplicate posts are removed.
 */
export function mergeShowcaseFeedKeepingVisibleItems<TItem extends FeedItemWithId>(
  currentItems: TItem[],
  incomingItems: TItem[],
  visibleItemCount: number,
): TItem[] {
  const boundedVisibleItemCount = Number.isFinite(visibleItemCount)
    ? Math.min(currentItems.length, Math.max(0, Math.trunc(visibleItemCount)))
    : 0;
  const mergedItems: TItem[] = [];
  const seenItemIds = new Set<string>();

  for (const item of currentItems.slice(0, boundedVisibleItemCount)) {
    if (!seenItemIds.has(item.id)) {
      seenItemIds.add(item.id);
      mergedItems.push(item);
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
