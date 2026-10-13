import type { ImmersivePreviewItem } from './immersive-preview-view-model';
import type { ShowcaseFeedRemovalTarget } from './showcase-feed-events';

/**
 * Refresh post data without reranking an already mounted reel. Moving its
 * active row lets the native scroll view paint the old offset before JS can
 * correct it, then virtualizes the playing cell away. New posts go at the end;
 * removed posts stay removed. A new viewer starts with the source's new order.
 *
 * `keepMissing` is for a reel that reads a grid's lane. A lane's refresh is a
 * new ranked session, which leaves out most of the posts the reader has seen,
 * the one on screen among them, so a post that is merely absent stays where it
 * is; the reel takes posts out itself (`removeViewerSessionItems`) when the
 * reader removes them.
 */
export function reconcileViewerSessionItems(
  previous: ImmersivePreviewItem[],
  incoming: ImmersivePreviewItem[],
  { keepMissing = false }: { keepMissing?: boolean } = {}
): ImmersivePreviewItem[] {
  const remaining = new Map(incoming.map((item) => [item.id, item]));
  const ordered: ImmersivePreviewItem[] = [];
  for (const item of previous) {
    const refreshed = remaining.get(item.id);
    if (!refreshed) {
      if (keepMissing) ordered.push(item);
      continue;
    }
    ordered.push(refreshed);
    remaining.delete(item.id);
  }
  return [...ordered, ...remaining.values()];
}

/** Whether a removal (Not interested, Hide, Report) takes this reel post out. */
export function isRemovedFromViewer(item: ImmersivePreviewItem, target: ShowcaseFeedRemovalTarget) {
  if (target.postId && (item.showcasePostId ?? item.id) === target.postId) return true;
  return Boolean(target.creatorId && item.creatorId === target.creatorId);
}

export function removeViewerSessionItems(items: ImmersivePreviewItem[], target: ShowcaseFeedRemovalTarget) {
  return items.filter((item) => !isRemovedFromViewer(item, target));
}
