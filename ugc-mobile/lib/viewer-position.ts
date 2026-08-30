import { buildImmersiveSlidePages, type ImmersiveSlidePage } from './immersive-slide-pages';
import type { ImmersivePreviewItem } from './immersive-preview-view-model';

export type ViewerPosition = { itemId: string; pageKey: string; mediaPageKey: string };

export function slidePageKey(page: ImmersiveSlidePage) {
  return page.type === 'media' ? `media:${page.mediaItem.id}` : page.type;
}

export function initialViewerPosition(item: ImmersivePreviewItem): ViewerPosition {
  const pageKey = buildImmersiveSlidePages(item).map(slidePageKey)[0] ?? 'text';
  return { itemId: item.id, pageKey, mediaPageKey: pageKey };
}

/** Keep identity through refetch/reordering; only missing content needs a fallback. */
export function resolveViewerPosition(items: ImmersivePreviewItem[], saved: ViewerPosition | null, initialId: string) {
  const item = items.find((candidate) => candidate.id === saved?.itemId)
    ?? items.find((candidate) => candidate.id === initialId)
    ?? items[0];
  if (!item) return null;
  if (!saved || item.id !== saved.itemId) return initialViewerPosition(item);
  const keys = buildImmersiveSlidePages(item).map(slidePageKey);
  const first = keys[0] ?? 'text';
  return {
    itemId: item.id,
    pageKey: keys.includes(saved.pageKey) ? saved.pageKey : first,
    mediaPageKey: keys.includes(saved.mediaPageKey) ? saved.mediaPageKey : first,
  };
}

/** Inactive cells can still emit native scroll events. They cannot own navigation. */
export function changeViewerPage(position: ViewerPosition, itemId: string, pageKey: string): ViewerPosition {
  if (position.itemId !== itemId || position.pageKey === pageKey) return position;
  return { ...position, pageKey, mediaPageKey: pageKey === 'details' ? position.mediaPageKey : pageKey };
}

export function settleViewerItem(position: ViewerPosition | null, item: ImmersivePreviewItem) {
  return position?.itemId === item.id ? position : initialViewerPosition(item);
}
