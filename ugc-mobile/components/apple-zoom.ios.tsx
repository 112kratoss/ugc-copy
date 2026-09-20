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
import { useEffect, type ReactNode } from 'react';
import { View } from 'react-native';

import {
  APPLE_ZOOM_SOURCE_PARAM,
  appleZoomSourceId,
  parseAppleZoomSourceId,
} from '@/lib/apple-zoom';
import { isAppleZoomAvailable } from '@/lib/apple-zoom-available';
import type { ZoomRect } from '@/lib/media-zoom-transition';

/** Registers the tile view inside as the zoom's source under `identifier`. */
export function AppleZoomSource({ identifier, children }: { identifier: string | null; children: ReactNode }) {
  if (!identifier || !isAppleZoomAvailable()) return children;
  return (
    // `animateAspectRatioChange`: a tile cropped to a shape other than its
    // media's (a profile grid cell) zooms into the part of the reel's picture
    // that has the tile's shape, and the rest of the picture is uncovered as
    // the window grows — Photos opening a square thumbnail.
    <LinkZoomTransitionSource identifier={identifier} animateAspectRatioChange>
      {children}
    </LinkZoomTransitionSource>
  );
}

/**
 * Marks where the reel draws the media of the post on screen, so the zoom
 * grows the tile into that rectangle and shrinks it back out of it, rather
 * than out of the whole screen with its bands and chrome. Keyed on the
 * identifier: Expo Router's detector registers once, under the identifier it
 * mounted with, so a re-pointed reel mounts a fresh one.
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
    if (!current || current.itemId === activeItemId) return;
    navigation.setParams({ [APPLE_ZOOM_SOURCE_PARAM]: appleZoomSourceId(current.surfaceId, activeItemId) } as never);
  }, [activeItemId, navigation, sourceId]);
}
