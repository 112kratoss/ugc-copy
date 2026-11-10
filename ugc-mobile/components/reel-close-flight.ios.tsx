/**
 * iOS: the views of a picture's own flight home when the reel's Back is
 * pressed; `lib/reel-close-flight.ts` says why it flies and holds its curves.
 */
import { Image } from 'expo-image';
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactElement } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { appleZoomSourceId } from '@/lib/apple-zoom';
import { appleZoomSurfaceBottomBar, isAppleZoomReturnPictureHeld, subscribeToAppleZoomReturnPictures } from '@/lib/apple-zoom-surface';
import { getZoomSource, isReturnableRect, mediaRectInScreen, type ZoomRect } from '@/lib/media-zoom-transition';
import {
  armReelCloseFlight,
  disarmReelCloseFlight,
  getReelCloseFlightPicture,
  isInReelBackRegion,
  isReelCloseFlightArmed,
  isReelCloseFlightPictureDisplayed,
  noteReelCloseFlightPictureDisplayed,
  offerReelCloseFlightPicture,
  REEL_BACK_PRESS_SLOP,
  reelCloseFlightCoversTile,
  reelCloseFlightFloor,
  reelCloseFlightFloorAt,
  reelCloseFlightFlying,
  reelCloseFlightFrame,
  reelCloseFlightGround,
  reelCloseFlightPicture,
  reelCloseFlightPlan,
  reelCloseFlightTime,
  subscribeToReelCloseFlight,
  takeOffReelCloseFlight,
  withdrawReelCloseFlightPicture,
} from '@/lib/reel-close-flight';
import { mediaColors } from '@/lib/theme';

/** What a slide needs to know of its reel to get its picture ready to fly. */
export interface ReelCloseFlightReel {
  /** This reel (`nextReelCloseFlightId`). */
  reelId: number;
  /** The surface of the tile the reel closes into, and the post the reader is on. */
  surfaceId: string | null;
  activeItemId: string | null;
  /** The reel shows that post's still picture, and the bar's Back is up. */
  enabled: boolean;
  /** Where the bar's Back is on screen. */
  back: ZoomRect;
}

export const ReelCloseFlightContext = createContext<ReelCloseFlightReel | null>(null);

/** How often a resting reel asks again where its tile is: the list under it can move. */
const TILE_REMEASURE_MS = 600;

/**
 * For the slide drawing a still picture: while that picture is the one its
 * reel would close on, has the layer draw it too and tells the flight which
 * tile it lands in. Draws nothing itself.
 */
export function ReelCloseFlightArm({
  postId,
  picture,
  aspectRatio,
  width,
  height,
}: {
  postId: string;
  /** The picture exactly as the slide draws it. */
  picture: { url: string; cacheKey?: string | null };
  /** width / height of the picture as the slide draws it. */
  aspectRatio: number | null | undefined;
  /** The slide, which is the whole screen. */
  width: number;
  height: number;
}) {
  const reel = useContext(ReelCloseFlightContext);
  const reelId = reel?.reelId ?? 0;
  const surfaceId = reel?.surfaceId ?? null;
  const wanted = Boolean(reel?.enabled && surfaceId && reel.activeItemId === postId && aspectRatio && aspectRatio > 0);
  // The tile holds the picture once the reel has landed on it
  // (`useAppleZoomRetarget`): only then is there a close to fly.
  const held = useSyncExternalStore(
    subscribeToAppleZoomReturnPictures,
    () => wanted && isAppleZoomReturnPictureHeld(surfaceId, postId)
  );
  const url = picture.url;
  const cacheKey = picture.cacheKey ?? null;
  const key = wanted && held ? `${reelId} ${postId} ${url} ${cacheKey ?? ''}` : null;
  const displayed = useSyncExternalStore(subscribeToReelCloseFlight, () => isReelCloseFlightPictureDisplayed(key));
  const backX = reel?.back.x ?? 0;
  const backY = reel?.back.y ?? 0;
  const backWidth = reel?.back.width ?? 0;
  const backHeight = reel?.back.height ?? 0;

  useEffect(() => {
    if (!key) return undefined;
    offerReelCloseFlightPicture({ key, url, cacheKey, from: mediaRectInScreen({ width, height }, aspectRatio) });
    return () => withdrawReelCloseFlightPicture(key);
  }, [aspectRatio, cacheKey, height, key, url, width]);

  useEffect(() => {
    if (!key || !displayed || !surfaceId) return undefined;
    let over = false;
    const screen = { width, height };
    const from = mediaRectInScreen(screen, aspectRatio);
    const arm = () => {
      const tile = getZoomSource(surfaceId, postId);
      if (!tile) {
        disarmReelCloseFlight(reelId);
        return;
      }
      tile.measure((rect) => {
        if (over) return;
        // Off screen, or not laid out: nowhere to land, and UIKit's zoom closes it.
        if (!isReturnableRect(rect, screen)) {
          disarmReelCloseFlight(reelId);
          return;
        }
        // The tile may sit under its screen's bar, which the flight is drawn over.
        const bar = appleZoomSurfaceBottomBar(surfaceId);
        armReelCloseFlight(
          {
            reelId,
            from,
            to: rect,
            radius: tile.radius,
            sourceId: appleZoomSourceId(surfaceId, postId),
            ...reelCloseFlightFloor(from, rect, screen, bar),
            back: { x: backX, y: backY, width: backWidth, height: backHeight },
          },
          { surfaceId, itemId: postId, hidden: !reelCloseFlightCoversTile(from, rect, height, bar.height) }
        );
      });
    };
    arm();
    const again = setInterval(arm, TILE_REMEASURE_MS);
    return () => {
      over = true;
      clearInterval(again);
      disarmReelCloseFlight(reelId);
    };
  }, [aspectRatio, backHeight, backWidth, backX, backY, displayed, height, key, postId, reelId, surfaceId, width]);

  return null;
}

/**
 * Reads a finger lifting off the bar's Back on the UI thread and sets the
 * picture off in that frame, before the button pops the reel. Wraps the view
 * the navigator is drawn in: the bar is UIKit's own, inside the navigator, and
 * a recognizer on a view above it is handed its touches first.
 *
 * It listens only while a picture is armed, lets go of every touch that does
 * not begin on the button as it begins, and never claims one: the button and
 * the reel answer their touches as they did.
 */
export function ReelCloseFlightTouches({ children }: { children: ReactElement }) {
  const armed = useSyncExternalStore(subscribeToReelCloseFlight, isReelCloseFlightArmed);
  const pressX = useSharedValue(0);
  const pressY = useSharedValue(0);
  const gesture = useMemo(() => Gesture.Manual()
    .enabled(armed)
    .cancelsTouchesInView(false)
    .onTouchesDown((event, manager) => {
      'worklet';
      const plan = reelCloseFlightPlan.value;
      const touch = event.allTouches[0];
      if (!plan || !touch || event.allTouches.length !== 1 || !isInReelBackRegion(plan.back, touch.absoluteX, touch.absoluteY)) {
        manager.fail();
        return;
      }
      pressX.value = touch.absoluteX;
      pressY.value = touch.absoluteY;
    })
    .onTouchesMove((event, manager) => {
      'worklet';
      const touch = event.allTouches[0];
      // Dragged off: the button gives the press up too.
      if (!touch || Math.abs(touch.absoluteX - pressX.value) > REEL_BACK_PRESS_SLOP || Math.abs(touch.absoluteY - pressY.value) > REEL_BACK_PRESS_SLOP) {
        manager.fail();
      }
    })
    .onTouchesUp((event, manager) => {
      'worklet';
      const plan = reelCloseFlightPlan.value;
      const touch = event.changedTouches[0];
      if (plan && touch && isInReelBackRegion(plan.back, touch.absoluteX, touch.absoluteY)) takeOffReelCloseFlight();
      // Out of the button's way: it takes the lift as its press.
      manager.fail();
    })
    .onTouchesCancelled((_event, manager) => {
      'worklet';
      manager.fail();
    }), [armed, pressX, pressY]);
  return <GestureDetector gesture={gesture}>{children}</GestureDetector>;
}

/**
 * The flown picture and the black under it, above the navigator. While a reel
 * rests on a picture that could fly, the picture is drawn here unseen, so that
 * a press finds it on the glass already.
 */
export function ReelCloseFlightLayer() {
  const picture = useSyncExternalStore(subscribeToReelCloseFlight, getReelCloseFlightPicture);
  const from = picture?.from ?? null;
  const fromX = from?.x ?? 0;
  const fromY = from?.y ?? 0;
  const fromWidth = from?.width ?? 0;
  const fromHeight = from?.height ?? 0;

  const layerStyle = useAnimatedStyle(() => ({ opacity: reelCloseFlightFlying.value ? 1 : 0 }));
  const groundStyle = useAnimatedStyle(() => ({ opacity: reelCloseFlightGround(reelCloseFlightTime.value) }));
  // What the picture is seen in: the screen, less the bar its tile sits under
  // (`reelCloseFlightFloor`). The bar has a button standing up out of its
  // middle, so that is three pieces: all of the screen above the button's top,
  // and the strip beside the button on either side, down to the bar itself.
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const skyStyle = useAnimatedStyle(() => {
    const plan = reelCloseFlightFlying.value;
    if (!plan) return { bottom: 0 };
    const held = reelCloseFlightFloorAt(plan, reelCloseFlightTime.value);
    return { bottom: held.floor + held.cap };
  });
  const besideLeftStyle = useAnimatedStyle(() => {
    const plan = reelCloseFlightFlying.value;
    if (!plan) return { left: 0, width: 0, bottom: 0, height: 0 };
    const held = reelCloseFlightFloorAt(plan, reelCloseFlightTime.value);
    return { left: 0, width: plan.capLeft, bottom: held.floor, height: held.cap };
  });
  const besideRightStyle = useAnimatedStyle(() => {
    const plan = reelCloseFlightFlying.value;
    if (!plan) return { left: 0, width: 0, bottom: 0, height: 0 };
    const held = reelCloseFlightFloorAt(plan, reelCloseFlightTime.value);
    const left = plan.capLeft + plan.capWidth;
    return { left, width: Math.max(0, screenWidth - left), bottom: held.floor, height: held.cap };
  });
  // The whole screen again inside each strip, so that the picture is drawn in
  // it where it is on the screen.
  const besideLeftScreenStyle = useAnimatedStyle(() => {
    const plan = reelCloseFlightFlying.value;
    const floor = plan ? reelCloseFlightFloorAt(plan, reelCloseFlightTime.value).floor : 0;
    return { left: 0, bottom: -floor };
  });
  const besideRightScreenStyle = useAnimatedStyle(() => {
    const plan = reelCloseFlightFlying.value;
    const floor = plan ? reelCloseFlightFloorAt(plan, reelCloseFlightTime.value).floor : 0;
    return { left: plan ? -(plan.capLeft + plan.capWidth) : 0, bottom: -floor };
  });
  const windowStyle = useAnimatedStyle(() => {
    const plan = reelCloseFlightFlying.value;
    if (!plan) {
      return { left: fromX, top: fromY, width: fromWidth, height: fromHeight, borderRadius: 0, borderCurve: 'continuous' as const, opacity: 1 };
    }
    const frame = reelCloseFlightFrame(plan, reelCloseFlightTime.value);
    return {
      left: frame.x,
      top: frame.y,
      width: frame.width,
      height: frame.height,
      borderRadius: frame.radius,
      borderCurve: 'continuous' as const,
      opacity: reelCloseFlightPicture.value,
    };
  });
  const imageStyle = useAnimatedStyle(() => {
    const plan = reelCloseFlightFlying.value;
    if (!plan) return { transform: [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }] };
    const frame = reelCloseFlightFrame(plan, reelCloseFlightTime.value);
    return { transform: [{ translateX: frame.imageX }, { translateY: frame.imageY }, { scale: frame.scale }] };
  });

  if (!picture) return null;
  const key = picture.key;
  // The picture in its window, once for each piece it is seen in.
  const flown = (onDisplay?: () => void) => (
    <Animated.View style={[{ position: 'absolute', overflow: 'hidden', borderCurve: 'continuous' }, windowStyle]}>
      <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: fromWidth, height: fromHeight }, imageStyle]}>
        <Image
          accessible={false}
          source={{ uri: picture.url, cacheKey: picture.cacheKey ?? undefined }}
          recyclingKey={key}
          contentFit="cover"
          transition={0}
          cachePolicy="memory-disk"
          onDisplay={onDisplay}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </Animated.View>
  );
  return (
    <Animated.View pointerEvents="none" accessibilityElementsHidden style={[StyleSheet.absoluteFill, layerStyle]}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: mediaColors.mediaGround }, groundStyle]} />
      <Animated.View style={[{ position: 'absolute', left: 0, top: 0, right: 0, overflow: 'hidden' }, skyStyle]}>
        {flown(() => noteReelCloseFlightPictureDisplayed(key))}
      </Animated.View>
      <Animated.View style={[{ position: 'absolute', overflow: 'hidden' }, besideLeftStyle]}>
        <Animated.View style={[{ position: 'absolute', width: screenWidth, height: screenHeight }, besideLeftScreenStyle]}>
          {flown()}
        </Animated.View>
      </Animated.View>
      <Animated.View style={[{ position: 'absolute', overflow: 'hidden' }, besideRightStyle]}>
        <Animated.View style={[{ position: 'absolute', width: screenWidth, height: screenHeight }, besideRightScreenStyle]}>
          {flown()}
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
}
