import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { View } from 'react-native';

import { easedFade, hexWithAlpha } from '@/lib/eased-fade';
import {
  LETTERBOX_EDGE_ALPHA,
  letterboxBands,
  mirroredBandPicture,
  type LetterboxBand,
} from '@/lib/letterbox';
import { mediaRectInScreen, type ZoomSize } from '@/lib/media-zoom-transition';

/** Each band's shade runs from its frame edge towards the picture. */
const DIRECTIONS: Record<LetterboxBand['edge'], { start: { x: number; y: number }; end: { x: number; y: number } }> = {
  top: { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } },
  bottom: { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } },
  left: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
  right: { start: { x: 1, y: 0 }, end: { x: 0, y: 0 } },
};

const FADE = easedFade(LETTERBOX_EDGE_ALPHA);
const COLORS = FADE.map((stop) => hexWithAlpha('#000000', stop.alpha)) as [string, string, ...string[]];
const LOCATIONS = FADE.map((stop) => stop.at) as [number, number, ...number[]];

/** The blur the bands have always had. */
const BAND_BLUR_RADIUS = 24;

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
 * picture to mirror.
 */
export function LetterboxBands({
  frame,
  aspectRatio,
  source,
}: {
  frame: ZoomSize;
  aspectRatio: number | null;
  source: { uri: string; cacheKey?: string | null } | null;
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
              <Image
                source={{ uri: source.uri, cacheKey: source.cacheKey ?? undefined }}
                contentFit="fill"
                blurRadius={BAND_BLUR_RADIUS}
                cachePolicy="memory-disk"
                priority="low"
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
            <LinearGradient
              colors={COLORS}
              locations={LOCATIONS}
              start={DIRECTIONS[band.edge].start}
              end={DIRECTIONS[band.edge].end}
              style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}
            />
          </View>
        );
      })}
    </>
  );
}
