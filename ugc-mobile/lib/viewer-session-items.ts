import type { ImmersivePreviewItem } from './immersive-preview-view-model';

/**
 * Refresh post data without reranking an already mounted reel. Moving its
 * active row lets the native scroll view paint the old offset before JS can
 * correct it, then virtualizes the playing cell away. New posts go at the end;
 * removed posts stay removed. A new viewer starts with the source's new order.
 */
export function reconcileViewerSessionItems(
  previous: ImmersivePreviewItem[],
  incoming: ImmersivePreviewItem[]
): ImmersivePreviewItem[] {
  const remaining = new Map(incoming.map((item) => [item.id, item]));
  const ordered: ImmersivePreviewItem[] = [];
  for (const item of previous) {
    const refreshed = remaining.get(item.id);
    if (!refreshed) continue;
    ordered.push(refreshed);
    remaining.delete(item.id);
  }
  return [...ordered, ...remaining.values()];
}
