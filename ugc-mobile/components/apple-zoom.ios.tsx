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
import { Image, type ImageStyle } from 'expo-image';
import { Link, useLocalSearchParams, useNavigation } from 'expo-router';
import { LinkZoomTransitionSource } from 'expo-router/build/link/preview/native';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import {
  APPLE_ZOOM_SOURCE_PARAM,
  appleZoomSourceId,
  isAppleZoomOpenSourceId,
  parseAppleZoomSourceId,
} from '@/lib/apple-zoom';
import { isAppleZoomAvailable } from '@/lib/apple-zoom-available';
import {
  clearAppleZoomReturn,
  holdAppleZoomReturnPicture,
  isAppleZoomReturnPictureHeld,
  prepareAppleZoomReturn,
  releaseAppleZoomReturnPicture,
  subscribeToAppleZoomReturnPictures,
} from '@/lib/apple-zoom-surface';
import { appleZoomAlignmentRect, type ZoomPreview, type ZoomRect, type ZoomSize } from '@/lib/media-zoom-transition';
import { listenForScreenLeaving, listenToTransition } from '@/lib/use-screen-leaving';

/**
 * Tiles kept from UIKit's zoom for one close (`withholdAppleZoomSource`).
 */
/** How many closes are keeping each tile from the zoom. */
const withheld = new Map<string, number>();
const withheldListeners = new Set<() => void>();

function subscribeToWithheld(listener: () => void) {
  withheldListeners.add(listener);
  return () => {
    withheldListeners.delete(listener);
  };
}

/**
 * Keeps the tile registered under `identifier` from UIKit's zoom until the
 * returned function is called: the reel's Back flies the picture alone into
 * the tile (`ZoomGeometry.pictureOnly`), and the pop under it must not zoom.
 *
 * Nothing on the reel's side turns the zoom off. It is the screen's
 * `preferredTransition`, set once by Expo Router, and it outranks the
 * navigation delegate's animator: with the reel's animation at `none`,
 * committed long before Back, UIKit still shrank a copy of the tile and a
 * black panel over the flight (simulator, 2026-11-07). What it cannot do is
 * zoom into a tile it is not given. The tile's view is re-registered under
 * another name, so the zoom's source lookup finds nothing for the post, and
 * the pop goes with no tile to shrink into while the picture flies over it.
 * React commits the rename before the pop that follows it, and UIKit asks for
 * the tile only as the pop begins.
 */
export function withholdAppleZoomSource(identifier: string): () => void {
  withheld.set(identifier, (withheld.get(identifier) ?? 0) + 1);
  withheldListeners.forEach((listener) => listener());
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    const left = (withheld.get(identifier) ?? 1) - 1;
    if (left > 0) withheld.set(identifier, left);
    else withheld.delete(identifier);
    withheldListeners.forEach((listener) => listener());
  };
}

/**
 * Registers the tile view inside as the zoom's source under `identifier`, with
 * the part of the reel's screen it lines up with.
 */
export function AppleZoomSource({
  identifier,
  aspectRatio,
  tile,
  pageShaped = false,
  children,
}: {
  identifier: string | null;
  /** width / height of the media as the reel draws it; null when the tile cannot know it. */
  aspectRatio: number | null;
  /** The tile view's size once laid out. */
  tile: ZoomSize | null;
  /**
   * The view inside is the reel's whole screen at the tile's scale, placed so
   * that its picture covers the tile (`appleZoomPageFrame`), and it lines up
   * with the whole screen rather than the picture.
   */
  pageShaped?: boolean;
  children: ReactNode;
}) {
  const { width, height } = useWindowDimensions();
  const alignment = useMemo(
    () => (!tile ? null : pageShaped ? { x: 0, y: 0, width, height } : appleZoomAlignmentRect({ width, height }, aspectRatio, tile)),
    [aspectRatio, height, pageShaped, tile, width]
  );
  const isWithheld = useSyncExternalStore(subscribeToWithheld, () => identifier !== null && withheld.has(identifier));
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
    <LinkZoomTransitionSource identifier={isWithheld ? `${identifier}#withheld` : identifier} alignment={alignment ?? undefined} animateAspectRatioChange>
      {children}
    </LinkZoomTransitionSource>
  );
}

/**
 * Marks where the reel draws the media of the post on screen, so a close
 * shrinks that rectangle into the tile rather than the whole screen with its
 * bands and chrome. UIKit finds it only for a pop the reel is still mounted
 * for — a drag down, a pinch, the edge swipe — which is where it tracks the
 * page on screen; Back takes the reel out of React first and lines up by the
 * tile's own alignment (`AppleZoomSource`). Not drawn while the push still
 * carries the page-shaped view it grew out of (`appleZoomOpenSourceId`), which
 * lines up with the whole page itself. Keyed on the identifier: Expo Router's
 * detector registers once, under the identifier it mounted with, so a
 * re-pointed reel mounts a fresh one.
 */
export function AppleZoomTarget({ rect }: { rect: ZoomRect }) {
  const identifier = useAppleZoomSourceId();
  // While the push still carries the page-shaped view it grew out of, the
  // zoom lines up with the whole page, as that view says itself.
  if (!identifier || isAppleZoomOpenSourceId(identifier)) return null;
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
 * How long after it mounts a reel counts as landed, whatever the navigator has
 * said. UIKit's zoom has drawn the reel at full size some 300 ms after the
 * push begins and reports the push's end half a second later still, once its
 * spring has settled (0.87 s after the push began, simulator, 2026-11-10).
 * Waiting for that report, a Back in that half second found the zoom still
 * pointing at the view the reel grew out of, and closed as a fade with the
 * tile's picture nowhere in it. The zoom asks for its views as a transition
 * begins, so the running push is not moved by the change.
 */
export const APPLE_ZOOM_LANDED_AFTER_MS = 450;

/** Navigation actions that pop a screen, which UIKit's zoom animates into the tile. */
const POP_ACTIONS = new Set(['GO_BACK', 'POP', 'POP_TO', 'POP_TO_TOP']);

/**
 * Points the zoom at the tile of the post the reader is on, so a close shrinks
 * into that tile rather than the one they tapped. The tile has to be on the
 * same surface and still mounted; UIKit shrinks the reel to the middle of the
 * screen when no view answers the identifier.
 */
export function useAppleZoomRetarget(
  activeItemId: string | null,
  /**
   * The reel is showing the still picture its post's tile shows: the tile
   * holds that picture in the view a close shrinks the reel into, so the
   * picture is on screen all the way down into the tile
   * (lib/apple-zoom-surface.ts). Not a video, whose tile would hold a frame the
   * reel has moved on from, nor a later picture of a post with several.
   */
  pictureReturns = false
) {
  const navigation = useNavigation();
  const sourceId = useAppleZoomSourceId();
  // Whether UIKit has begun to take the reel away: by a pop of its own (the
  // bar's Back, a drag, the edge swipe) the reel leaves React only once the pop
  // is over, where a pop the app asks for takes it out of React first.
  const leavingRef = useRef(false);
  useEffect(() => listenForScreenLeaving(navigation, (leaving) => {
    leavingRef.current = leaving;
  }), [navigation]);
  // Whether the app has asked to pop the reel (`router.back()`, a dismiss), a
  // removal UIKit's zoom carries into the tile. A replace, a reset or any other
  // way out takes the reel away with no zoom, and the tile is given its picture
  // back at once rather than standing hidden until a pop that never comes.
  const poppedRef = useRef(false);
  useEffect(() => navigation.addListener('beforeRemove', (event) => {
    poppedRef.current = POP_ACTIONS.has(event.data.action.type);
  }), [navigation]);
  // Declared before the effect that holds the picture, so that it has run by
  // the time that one lets go. Reset on mount: React runs an effect, its
  // cleanup and the effect again in development.
  const unmountingRef = useRef(false);
  useEffect(() => {
    unmountingRef.current = false;
    return () => {
      unmountingRef.current = true;
    };
  }, []);
  // A reel grows out of the page-shaped view beside its tile
  // (`appleZoomOpenSourceId`) and closes into the tile's own view, which UIKit
  // shrinks it into the shape of. It changes over once the reel has landed:
  // when the navigator reports the push's end, or `APPLE_ZOOM_LANDED_AFTER_MS`
  // after the reel mounted, whichever comes first.
  const opening = isAppleZoomOpenSourceId(sourceId);
  const [landed, setLanded] = useState(!opening);
  useEffect(() => {
    if (landed) return undefined;
    const unsubscribe = listenToTransition(navigation, 'transitionEnd', (event) => {
      if (event.data?.closing === false) setLanded(true);
    });
    const deadline = setTimeout(() => setLanded(true), APPLE_ZOOM_LANDED_AFTER_MS);
    return () => {
      unsubscribe();
      clearTimeout(deadline);
    };
  }, [landed, navigation]);
  useEffect(() => {
    if (!sourceId || !activeItemId) return;
    const current = parseAppleZoomSourceId(sourceId);
    if (!current) return;
    prepareAppleZoomReturn(current.surfaceId, activeItemId);
    if (landed && (opening || current.itemId !== activeItemId)) {
      navigation.setParams({ [APPLE_ZOOM_SOURCE_PARAM]: appleZoomSourceId(current.surfaceId, activeItemId) } as never);
    }
    return () => clearAppleZoomReturn(current.surfaceId, activeItemId);
  }, [activeItemId, landed, navigation, opening, sourceId]);
  // The tile's picture, held for the close once the push has landed (a close
  // before that shrinks into the page-shaped view the push grew out of), and
  // let go when the reader moves on or the reel goes.
  const surfaceId = parseAppleZoomSourceId(sourceId)?.surfaceId ?? null;
  useEffect(() => {
    if (!surfaceId || !activeItemId || !landed || !pictureReturns) return undefined;
    holdAppleZoomReturnPicture(surfaceId, activeItemId);
    return () => {
      // Going with the reel still on screen: the app asked for the pop, which
      // has yet to begin, and the picture stays until it is over.
      releaseAppleZoomReturnPicture(surfaceId, activeItemId, unmountingRef.current && !leavingRef.current && poppedRef.current);
    };
  }, [activeItemId, landed, pictureReturns, surfaceId]);
}

/** What a tile draws in the view a close shrinks the reel into; see `useAppleZoomReturnPicture`. */
export interface AppleZoomReturnPicture {
  /** The picture drawn there; null while the view is empty. */
  picture: ZoomPreview | null;
  /**
   * The picture is drawn and stands in for the tile, which hides what it
   * draws itself: UIKit takes the view out of the page while a close flies it,
   * and the tile's own picture would show in its place beside the one coming
   * home.
   */
  covers: boolean;
  /** The view has drawn its picture. */
  onDisplay: () => void;
}

/**
 * The tile's half of the picture a close lands on (lib/apple-zoom-surface.ts):
 * while a reel holds this tile's picture, the view UIKit's zoom shrinks the
 * reel into draws it (`AppleZoomReturnPictureView`), and once it has, the tile
 * hides its own content under it. When the reel lets go, the view empties and
 * the tile shows again in the same commit, so the picture that landed gives
 * way to the tile itself with nothing between them.
 *
 * Nothing fades here: UIKit flies a live copy of the view that follows what
 * the view draws and ignores the view's own opacity (simulator, 2026-11-10: a
 * picture taken out mid-flight vanished from the flight, one faded on the view
 * did not change). The tile's badges and shade come back through a copy of the
 * picture the tile draws over itself (`ZoomReturnVeil`,
 * components/media-zoom.tsx).
 */
export function useAppleZoomReturnPicture(
  surfaceId: string | null,
  itemId: string,
  preview: ZoomPreview | null
): AppleZoomReturnPicture {
  const held = useSyncExternalStore(
    subscribeToAppleZoomReturnPictures,
    () => isAppleZoomReturnPictureHeld(surfaceId, itemId)
  );
  const url = preview?.url ?? null;
  const cacheKey = preview?.cacheKey ?? null;
  // The picture as one value: a list cell handed another post, or a tile whose
  // picture changed, has not drawn the new one.
  const pictureKey = held && url ? `${itemId} ${url} ${cacheKey ?? ''}` : null;
  const [drawnKey, setDrawnKey] = useState<string | null>(null);
  // Let go: the view has emptied, and a picture held again has to be drawn again.
  if (pictureKey === null && drawnKey !== null) setDrawnKey(null);
  // The view reports every time it draws, which it does again whenever UIKit
  // changes its size; one that comes after the reel has let go draws nothing.
  const onDisplay = useCallback(() => setDrawnKey(pictureKey), [pictureKey]);
  const picture = useMemo(() => (held && url ? { url, cacheKey } : null), [cacheKey, held, url]);
  return { picture, covers: pictureKey !== null && drawnKey === pictureKey, onDisplay };
}

/**
 * The view a close shrinks the reel into (`AppleZoomSource`'s one child): the
 * tile's rectangle and corners, empty until a reel holds the tile's picture
 * (`useAppleZoomReturnPicture`; a tile built without one is always empty). An image view rather than a plain one holding
 * a picture: UIKit resizes the view it zooms, and a React Native view keeps
 * what it holds at the size and place Yoga gave it, where expo-image's own
 * image view fills its bounds as they change.
 */
export function AppleZoomReturnPictureView({ returnPicture, radius }: { returnPicture?: AppleZoomReturnPicture; radius: number }) {
  const picture = returnPicture?.picture ?? null;
  return (
    <Image
      pointerEvents="none"
      accessible={false}
      source={picture ? { uri: picture.url, cacheKey: picture.cacheKey ?? undefined } : null}
      // expo-image keeps the last picture when its source goes; a new key is
      // what empties it, at once, as the reel lets go.
      recyclingKey={picture ? `${picture.url} ${picture.cacheKey ?? ''}` : null}
      contentFit="cover"
      transition={0}
      cachePolicy="memory-disk"
      onDisplay={returnPicture?.onDisplay}
      style={[StyleSheet.absoluteFill, { borderRadius: radius, borderCurve: 'continuous' } as ImageStyle]}
    />
  );
}

