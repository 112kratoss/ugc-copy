import { View } from 'react-native';

import { BackdropImage } from '@/components/backdrop-image';
import { easedFade, hexWithAlpha, linearGradient } from '@/lib/eased-fade';
import {
  LETTERBOX_EDGE_ALPHA,
  letterboxBands,
  mirroredBandPicture,
  type LetterboxBand,
} from '@/lib/letterbox';
import { mediaRectInScreen, type ZoomSize } from '@/lib/media-zoom-transition';

const FADE = easedFade(LETTERBOX_EDGE_ALPHA).map(({ at, alpha }) => ({ at, color: hexWithAlpha('#000000', alpha) }));

/**
 * Each band's shade runs from its frame edge towards the picture. It is React
 * Native's own gradient, as the reel's other shades are (`components/reel-chrome.tsx`).
 */
const SHADES: Record<LetterboxBand['edge'], string> = {
  top: linearGradient('to bottom', FADE),
  bottom: linearGradient('to top', FADE),
  left: linearGradient('to right', FADE),
  right: linearGradient('to left', FADE),
};

/** The blur the bands have always had, for a picture without a thumbhash; see BackdropImage. */
export const BAND_BLUR_RADIUS = 24;

/**
 * The bands around a `contain`-fitted picture: each shows the picture's own edge
 * mirrored outward and blurred, under a shade that is darkest at the frame's
 * edge and gone where the picture begins (`lib/letterbox.ts`). The band meets
 * the picture with the picture's own edge, in brightness as well as colour.
 *
 * Draw it *under* the picture: each band reaches a little way under the picture
 * so that no rounding can open a gap along the seam (`LETTERBOX_SEAM_OVERLAP`),
 * and only the picture on top hides that overlap. Nothing for a picture of
 * unknown shape, whose bands cannot be placed; only the shade when there is no
 * picture to mirror. The picture's thumbhash draws the bands where it has one:
 * it is the picture already blurred, so nothing is blurred at draw time.
 */
export function LetterboxBands({
  frame,
  aspectRatio,
  source,
}: {
  frame: ZoomSize;
  aspectRatio: number | null;
  source: { uri: string; cacheKey?: string | null; thumbhash?: string | null } | null;
}) {
  if (!aspectRatio || frame.width <= 0 || frame.height <= 0) return null;
  const media = mediaRectInScreen(frame, aspectRatio);
  return (
    <>
      {letterboxBands(frame, media).map((band) => {
        const copy = mirroredBandPicture(band, media);
        return (
          <View
            key={band.edge}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: copy.area.x,
              top: copy.area.y,
              width: copy.area.width,
              height: copy.area.height,
              overflow: 'hidden',
            }}
          >
            {source ? (
              <BackdropImage
                thumbhash={source.thumbhash}
                source={{ uri: source.uri, cacheKey: source.cacheKey ?? undefined }}
                recyclingKey={`letterbox:${source.uri}:${source.cacheKey ?? ''}:${band.edge}`}
                blurRadius={BAND_BLUR_RADIUS}
                contentFit="fill"
                transition={0}
                style={{
                  position: 'absolute',
                  left: copy.x,
                  top: copy.y,
                  width: copy.width,
                  height: copy.height,
                  transform: [copy.flip === 'vertical' ? { scaleY: -1 } : { scaleX: -1 }],
                }}
              />
            ) : null}
            <View
              style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, experimental_backgroundImage: SHADES[band.edge] }}
            />
          </View>
        );
      })}
    </>
  );
}
