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
 *
 * `anchorId` is the post the reader is on. A post above it that the refresh
 * left out stays too, whatever the source: taking it out moves the reader's
 * row up by one, which is the same jump as a reorder. A For you reel a link
 * opened on Home's cached page refetches a new ranked page; on Android the
 * native list drew the post that moved into the old offset for 70 to 180 ms
 * before the alignment scroll put the reader back (Pixel_9a, 2026-11-25).
 * Below the reader a missing post still goes, as nothing above them moves.
 */
export function reconcileViewerSessionItems(
  previous: ImmersivePreviewItem[],
  incoming: ImmersivePreviewItem[],
  { keepMissing = false, anchorId = null }: { keepMissing?: boolean; anchorId?: string | null } = {}
): ImmersivePreviewItem[] {
  const remaining = new Map(incoming.map((item) => [item.id, item]));
  const anchorIndex = anchorId ? previous.findIndex((item) => item.id === anchorId) : -1;
  const ordered: ImmersivePreviewItem[] = [];
  for (const [index, item] of previous.entries()) {
    const refreshed = remaining.get(item.id);
    if (!refreshed) {
      if (keepMissing || index < anchorIndex) ordered.push(item);
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
