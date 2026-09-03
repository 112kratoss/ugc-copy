import {
  hasImmersiveDetailsPage,
  type ImmersivePreviewItem,
} from './immersive-preview-view-model';
import type { ShowcaseMediaItem } from './types';

export type ImmersiveSlidePage =
  | { type: 'text' }
  | { type: 'status' }
  | { type: 'media'; mediaIndex: number; mediaItem: ShowcaseMediaItem }
  | { type: 'details' };

/**
 * Every slide gets a page that is not the details page.
 *
 * The details page is the reel's overlay: while it is up the reel stops
 * scrolling and hides its own back arrow, because the page draws its own way
 * back to the media underneath it. A creation with no media -- a failed run,
 * or one still rendering -- used to produce `[details]` and nothing else, so
 * the reel opened straight into its own overlay with nothing underneath: no
 * scroll, no back arrow, no header button, and Android's back key routed to a
 * "show the media" handler that had no media to show. The status page is that
 * missing ground floor, and it says why the media is absent.
 */
export function buildImmersiveSlidePages(item: ImmersivePreviewItem): ImmersiveSlidePage[] {
  const pages: ImmersiveSlidePage[] = [];

  if (item.previewKind === 'text') {
    pages.push({ type: 'text' });
  } else {
    const mediaItems = item.mediaItems ?? [];
    if (mediaItems.length === 0) {
      pages.push({ type: 'status' });
    }
    mediaItems.forEach((mediaItem, index) => {
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
    // A text post has no media to swipe back to — it has the writing. Neither
    // does a run that produced nothing, and promising it media it never made
    // is the one thing that page must not do.
    if (item.previewKind === 'text') return 'Swipe right for the post';
    return pages.some((page) => page.type === 'status') ? 'Swipe right to go back' : 'Swipe right for media';
  }

  return currentHorizontalIndex < detailsIndex - 1
    ? 'Swipe left for more media'
    : 'Swipe left for details';
}

export function getImmersiveVideoBlockerId({
  actionsOpenItemId,
  commentsOpenItemId,
  detailsPageOpenItemId,
  unlockRemixOpenItemId,
}: {
  actionsOpenItemId: string | null;
  commentsOpenItemId?: string | null;
  detailsPageOpenItemId: string | null;
  unlockRemixOpenItemId?: string | null;
}) {
  return unlockRemixOpenItemId
    ?? commentsOpenItemId
    ?? detailsPageOpenItemId
    ?? actionsOpenItemId;
}
