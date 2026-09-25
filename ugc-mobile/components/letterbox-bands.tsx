import { View } from 'react-native';

import { bandArea, letterboxBands } from '@/lib/letterbox';
import { mediaRectInScreen, type ZoomSize } from '@/lib/media-zoom-transition';
import { mediaColors } from '@/lib/theme';

/**
 * The bands around a `contain`-fitted picture: plain black, as a video player
 * draws them. They showed the picture's own edge, mirrored and blurred, until
 * the owner chose black on 2026-09-25; black also leaves nothing to download,
 * decode or blur for them.
 *
 * Draw it *under* the picture: each band reaches a little way under the picture
 * so that no rounding can open a gap along the seam (`LETTERBOX_SEAM_OVERLAP`),
 * and only the picture on top hides that overlap. Nothing for a picture of
 * unknown shape, whose bands cannot be placed.
 */
export function LetterboxBands({ frame, aspectRatio }: { frame: ZoomSize; aspectRatio: number | null }) {
  if (!aspectRatio || frame.width <= 0 || frame.height <= 0) return null;
  const media = mediaRectInScreen(frame, aspectRatio);
  return (
    <>
      {letterboxBands(frame, media).map((band) => {
        const area = bandArea(band);
        return (
          <View
            key={band.edge}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: area.x,
              top: area.y,
              width: area.width,
              height: area.height,
              backgroundColor: mediaColors.mediaGround,
            }}
          />
        );
      })}
    </>
  );
}
