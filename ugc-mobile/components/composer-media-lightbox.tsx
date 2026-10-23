import { useMemo } from 'react';

import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';
import { readableFileName } from '@/lib/media-file-names';
import type { PostComposerMediaItem } from '@/lib/post-new-view-model';

/**
 * How a composer media slot is named everywhere the user can see it: the strip
 * card, the lightbox heading, and the screen-reader labels all agree that slot
 * zero is the cover.
 */
export function getComposerMediaLabel(index: number) {
  return index === 0 ? 'Cover' : `Media ${index + 1}`;
}

/**
 * A slot's file name as the strip card and the lightbox caption show it: the name where it says
 * something, else null. Android's photo picker names a picture after its media id ("1000333161.jpg"),
 * and an edited post's item with no name of its own carries its id (a UUID, or "<post id>:cover" for a
 * post older than its media rows).
 */
export function getComposerMediaFileName(item: Pick<PostComposerMediaItem, 'name' | 'existingId'>) {
  if (item.existingId && item.name === item.existingId) return null;
  return readableFileName(item.name);
}

/** The composer's media slots, previewed on the app's shared lightbox. */
export function ComposerMediaLightbox({
  items,
  activeIndex,
  onClose,
  onNavigate,
}: {
  items: PostComposerMediaItem[];
  activeIndex: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const lightboxItems = useMemo<LightboxMediaItem[]>(
    () => items.map((item, index) => ({
      id: `composer:${item.id}`,
      // Existing video posts carry an image poster in previewUrl.
      url: item.mediaKind === 'video' ? item.uri : item.previewUrl ?? item.uri,
      mediaKind: item.mediaKind,
      label: getComposerMediaLabel(index),
      caption: getComposerMediaFileName(item),
    })),
    [items]
  );

  return (
    <MediaLightbox
      items={lightboxItems}
      activeIndex={activeIndex}
      onClose={onClose}
      onNavigate={onNavigate}
    />
  );
}
