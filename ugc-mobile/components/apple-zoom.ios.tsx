/**
 * iOS bindings of Expo Router's zoom transition for the reel; see
 * `lib/apple-zoom.ts` for the whole arrangement.
 *
 * `LinkZoomTransitionSource` is the native view Expo Router's `Link.AppleZoom`
 * renders, reached directly because the tiles open the reel imperatively and
 * `Link.AppleZoom` insists on a `Link`. It registers its one native child under
 * `identifier` with the module that answers UIKit's source-view request, and
 * unregisters it when that child goes.
 */
import { Link, useLocalSearchParams, useNavigation } from 'expo-router';
import { LinkZoomTransitionSource } from 'expo-router/build/link/preview/native';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useWindowDimensions, View } from 'react-native';

import {
  APPLE_ZOOM_SOURCE_PARAM,
  appleZoomSourceId,
  parseAppleZoomSourceId,
} from '@/lib/apple-zoom';
import { isAppleZoomAvailable } from '@/lib/apple-zoom-available';
import { clearAppleZoomReturn, prepareAppleZoomReturn } from '@/lib/apple-zoom-surface';
import { appleZoomAlignmentRect, type ZoomRect, type ZoomSize } from '@/lib/media-zoom-transition';

/**
 * Registers the tile view inside as the zoom's source under `identifier`, with
 * the part of the reel's screen it lines up with.
 */
export function AppleZoomSource({
  identifier,
  aspectRatio,
  tile,
  children,
}: {
  identifier: string | null;
  /** width / height of the media as the reel draws it; null when the tile cannot know it. */
  aspectRatio: number | null;
  /** The tile view's size once laid out. */
  tile: ZoomSize | null;
  children: ReactNode;
}) {
  const { width, height } = useWindowDimensions();
  const alignment = useMemo(
    () => (tile ? appleZoomAlignmentRect({ width, height }, aspectRatio, tile) : null),
    [aspectRatio, height, tile, width]
  );
  if (!identifier || !isAppleZoomAvailable()) return children;
  return (
    // `animateAspectRatioChange`: a tile cropped to a shape other than its
    // media's (a profile grid cell) zooms into the part of the reel's picture
    // that has the tile's shape, and the rest of the picture is uncovered as
    // the window grows — Photos opening a square thumbnail.
    //
    // `alignment` is that part of the picture, worked out by the tile. UIKit
    // asks where to line the tile up as each transition begins; Expo Router
    // answers from the reel's `AppleZoomTarget` when it finds one, and from
    // this otherwise. The push begins before the reel's slide has mounted its
    // mark, and Back takes the reel out of React before the pop begins
    // (react-native-screens draws a snapshot of it instead). With no alignment
    // at those moments UIKit pinned the tile's crop to the top of the reel's
    // screen: closing a Holi clip into its Home card, the card's picture sat at
    // the top of the shrinking window with the reel's below it, two copies of
    // her waist sliding into each other as though the reel were scrolling in.
    <LinkZoomTransitionSource identifier={identifier} alignment={alignment ?? undefined} animateAspectRatioChange>
      {children}
    </LinkZoomTransitionSource>
  );
}

/**
 * Marks where the reel draws the media of the post on screen, so the zoom
 * grows the tile into that rectangle and shrinks it back out of it, rather
 * than out of the whole screen with its bands and chrome. UIKit finds it only
 * for a pop the reel is still mounted for — a drag down, a pinch, the edge
 * swipe — which is where it tracks the page on screen; the push and Back line
 * up by the tile's own alignment (`AppleZoomSource`). Keyed on the identifier:
 * Expo Router's detector registers once, under the identifier it mounted with,
 * so a re-pointed reel mounts a fresh one.
 */
export function AppleZoomTarget({ rect }: { rect: ZoomRect }) {
  const identifier = useAppleZoomSourceId();
  if (!identifier) return null;
  return (
    <Link.AppleZoomTarget key={identifier}>
      <View
        pointerEvents="none"
        collapsable={false}
        style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      />
    </Link.AppleZoomTarget>
  );
}

/** The identifier the screen was pushed with, re-pointed or not; null for a screen pushed any other way. */
export function useAppleZoomSourceId(): string | null {
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const value = params[APPLE_ZOOM_SOURCE_PARAM];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Points the zoom at the tile of the post the reader is on, so a close shrinks
 * into that tile rather than the one they tapped. The tile has to be on the
 * same surface and still mounted; UIKit shrinks the reel to the middle of the
 * screen when no view answers the identifier.
 */
export function useAppleZoomRetarget(activeItemId: string | null) {
  const navigation = useNavigation();
  const sourceId = useAppleZoomSourceId();
  useEffect(() => {
    if (!sourceId || !activeItemId) return;
    const current = parseAppleZoomSourceId(sourceId);
    if (!current) return;
    prepareAppleZoomReturn(current.surfaceId, activeItemId);
    if (current.itemId !== activeItemId) {
      navigation.setParams({ [APPLE_ZOOM_SOURCE_PARAM]: appleZoomSourceId(current.surfaceId, activeItemId) } as never);
    }
    return () => clearAppleZoomReturn(current.surfaceId, activeItemId);
  }, [activeItemId, navigation, sourceId]);
}
