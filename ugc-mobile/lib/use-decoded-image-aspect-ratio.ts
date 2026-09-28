import { useCallback, useSyncExternalStore } from 'react';

import { decodedImageAspectRatio, subscribeDecodedImageAspectRatio } from './decoded-image-aspect-ratio';

/** Descriptor dimensions win; decoding fills gaps without changing feed crops. */
export function useDecodedImageAspectRatio(
  declared: number | null,
  previewUrl?: string | null,
  imageUrl?: string | null,
) {
  const subscribe = useCallback((listener: () => void) => {
    if (declared !== null) return () => {};
    const offPreview = subscribeDecodedImageAspectRatio(previewUrl, listener);
    const offImage = subscribeDecodedImageAspectRatio(imageUrl, listener);
    return () => { offPreview(); offImage(); };
  }, [declared, previewUrl, imageUrl]);
  const getSnapshot = useCallback(
    () => declared ?? decodedImageAspectRatio(previewUrl) ?? decodedImageAspectRatio(imageUrl),
    [declared, previewUrl, imageUrl],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
