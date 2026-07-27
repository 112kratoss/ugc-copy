import {
  hasImmersiveDetailsPage,
  type ImmersivePreviewItem,
} from './immersive-preview-view-model';
import type { ShowcaseMediaItem } from './types';

export type ImmersiveSlidePage =
  | { type: 'text' }
  | { type: 'media'; mediaIndex: number; mediaItem: ShowcaseMediaItem }
  | { type: 'details' };

export function buildImmersiveSlidePages(item: ImmersivePreviewItem): ImmersiveSlidePage[] {
  const pages: ImmersiveSlidePage[] = [];

  if (item.previewKind === 'text') {
    pages.push({ type: 'text' });
  } else {
    (item.mediaItems ?? []).forEach((mediaItem, index) => {
      pages.push({
        type: 'media',
        mediaIndex: index,
        mediaItem,
      });
    });
  }

  if (hasImmersiveDetailsPage(item)) {
    pages.push({ type: 'details' });
  }

  return pages;
}

export function isImmersiveDetailsSlidePageIndex(pages: ImmersiveSlidePage[], pageIndex: number) {
  return pages[pageIndex]?.type === 'details';
}

export function getImmersiveSlideHint({
  currentHorizontalIndex,
  item,
  pages,
}: {
  currentHorizontalIndex: number;
  item: ImmersivePreviewItem;
  pages: ImmersiveSlidePage[];
}) {
  if (!hasImmersiveDetailsPage(item)) {
    return null;
  }

  const detailsIndex = pages.findIndex((page) => page.type === 'details');
  if (detailsIndex < 0) {
    return null;
  }

  if (currentHorizontalIndex === detailsIndex) {
    return 'Swipe right for media';
  }

  return currentHorizontalIndex < detailsIndex - 1
    ? 'Swipe left for more media'
    : 'Swipe left for details';
}

export function getImmersiveVideoBlockerId({
  actionsOpenItemId,
  commentsOpenItemId,
  detailsPageOpenItemId,
  detailsSheetOpenItemId,
  unlockRemixOpenItemId,
}: {
  actionsOpenItemId: string | null;
  commentsOpenItemId?: string | null;
  detailsPageOpenItemId: string | null;
  detailsSheetOpenItemId: string | null;
  unlockRemixOpenItemId?: string | null;
}) {
  return unlockRemixOpenItemId
    ?? commentsOpenItemId
    ?? detailsPageOpenItemId
    ?? detailsSheetOpenItemId
    ?? actionsOpenItemId;
}
