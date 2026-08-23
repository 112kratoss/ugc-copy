import { useMemo } from 'react';

import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';
import type { PostComposerMediaItem } from '@/lib/post-new-view-model';

/**
 * How a composer media slot is named everywhere the user can see it: the strip
 * card, the lightbox heading, and the screen-reader labels all agree that slot
 * zero is the cover.
 */
export function getComposerMediaLabel(index: number) {
  return index === 0 ? 'Cover' : `Media ${index + 1}`;
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
      url: item.previewUrl ?? item.uri,
      mediaKind: item.mediaKind,
      label: getComposerMediaLabel(index),
      caption: item.name,
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
