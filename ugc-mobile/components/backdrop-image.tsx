import { Image, type ImageProps } from 'expo-image';

import { nativeBlurRadius } from '@/lib/media-blur';

export type BackdropSource = { uri: string; cacheKey?: string; headers?: Record<string, string> };

/**
 * The soft picture behind a piece of media: a feed frame's backdrop, a video
 * tile's poster wash, the reel's letterbox bands.
 *
 * Drawn from the picture's thumbhash when it has one. A thumbhash *is* a blur
 * of the picture, decoded from a few dozen bytes already in hand, so it costs
 * no download, no second decode and no native transformation, and it is on
 * screen before the picture itself. Only a picture without one is blurred at
 * draw time, and only where the native loader can do that safely
 * (`nativeBlurRadius`); otherwise the frame's own background stands in, which
 * is what every blur was drawn over anyway.
 */
export function BackdropImage({
  thumbhash,
  source,
  blurRadius,
  contentFit = 'cover',
  recyclingKey,
  transition = 0,
  style,
}: {
  thumbhash?: string | null;
  source?: BackdropSource | null;
  /** Asked of the loader only for a picture without a thumbhash. */
  blurRadius: number;
  contentFit?: 'cover' | 'fill';
  recyclingKey?: string;
  transition?: number;
  style?: ImageProps['style'];
}) {
  if (thumbhash) {
    return (
      <Image
        placeholder={{ thumbhash }}
        placeholderContentFit={contentFit}
        contentFit={contentFit}
        recyclingKey={recyclingKey}
        transition={transition}
        pointerEvents="none"
        style={style}
      />
    );
  }

  const radius = nativeBlurRadius(blurRadius);
  if (!source?.uri || radius === undefined) return null;

  return (
    <Image
      source={source}
      contentFit={contentFit}
      blurRadius={radius}
      cachePolicy="memory-disk"
      priority="low"
      recyclingKey={recyclingKey}
      transition={transition}
      pointerEvents="none"
      style={style}
    />
  );
}
