/**
 * iOS 18: what the reel's page does as UIKit's zoom closes it into a tile.
 *
 * UIKit shrinks the whole page toward the tile and crossfades it into the
 * tile's picture (lib/apple-zoom.ts, lib/apple-zoom-surface.ts). The two are
 * lined up on the part of the reel's picture that has the tile's shape, and
 * everything else on the page hangs outside the tile on the way down and
 * fades there, over the feed: the top and bottom of a picture taller than its
 * tile, the caption and rail, the page's black. Filmed on a Home card
 * (owner's recording, 2026-11-10) that read as a second, larger picture
 * ghosting over the card's name row and buttons for a dozen frames.
 *
 * So the page is cut down to what the tile shows as the close goes on: its
 * black and its chrome fade out and the picture is trimmed to the tile's part
 * of it, corners and all (`ReelCloseMorphClip`), well before the page reaches
 * the tile (`ReelCloseMorphCue`). What UIKit then crossfades into the tile's
 * picture is that same picture in the same place, with nothing of ours around
 * it. The feed shows where the page was: a page clear behind its media is
 * clear to UIKit as well (simulator, iOS 26.4).
 *
 * UIKit still draws a backdrop of its own behind the page and masks it down
 * toward the tile, and the part of it above the picture is the last to go: a
 * dark band over whatever is above the tile, for 20 to 40 ms (filmed with the
 * page frozen cut down over a red backing: nothing of the page is in it).
 * Giving the screen a background of its own to shape that backdrop made UIKit
 * draw the whole page opaque, so the screen stays clear.
 *
 * Only for a close whose picture the tile holds (`pictureReturns` in
 * app/viewer.tsx): a video's close is unchanged.
 *
 * Since 2026-11-10 this is what a finger's close does (the edge swipe, a drag
 * down), and what the bar's Back falls back to. A press of the bar's Back
 * otherwise takes the picture off the page altogether and flies it home
 * (lib/reel-close-flight.ts), and there is no page left here to cut down.
 */
import { useNavigation } from 'expo-router';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useTransitionProgress } from 'react-native-screens';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';

import { appleZoomTileShape, isAppleZoomReturnPictureHeld, type AppleZoomTileShape } from '@/lib/apple-zoom-surface';
import { mediaRectInScreen } from '@/lib/media-zoom-transition';
import { confirmReelCloseFlight } from '@/lib/reel-close-flight';
import type { ReelTouches } from '@/lib/reel-touches';
import { listenForScreenLeaving } from '@/lib/use-screen-leaving';

/**
 * The share of a dragged close's progress by which the page has become the
 * tile's part of its picture.
 */
export const REEL_CLOSE_MORPH_FULL_AT = 0.3;
/** How long a close no finger began takes to cut the page down. */
export const REEL_CLOSE_MORPH_MS = 60;
/**
 * How long before a close is heard of a touch on the reel still counts as the
 * finger that began it. UIKit's gesture takes the touch from React Native as
 * it recognizes, just before the navigator reports the close.
 */
const FINGER_LEAD_MS = 500;
/** How long the page takes to follow each report of the progress. */
export const REEL_CLOSE_MORPH_EASE_MS = 50;
/** How long it takes to come back when a close is let go of. */
export const REEL_CLOSE_MORPH_BACK_MS = 180;

/** How far the page is cut down at `progress` of a close: 0 whole, 1 the tile's part alone. */
export function reelCloseMorphAt(progress: number) {
  if (!(progress > 0)) return 0;
  return Math.min(1, progress / REEL_CLOSE_MORPH_FULL_AT);
}

export interface ReelCloseMorph {
  /** 0 with the page whole, 1 once it is the tile's part of the picture alone. */
  progress: SharedValue<number>;
  /** The tile being closed into; null leaves the picture untrimmed. */
  tile: SharedValue<AppleZoomTileShape | null>;
}

const ReelCloseMorphContext = createContext<ReelCloseMorph | null>(null);

export function useReelCloseMorph(): ReelCloseMorph {
  const progress = useSharedValue(0);
  const tile = useSharedValue<AppleZoomTileShape | null>(null);
  return useMemo(() => ({ progress, tile }), [progress, tile]);
}

export function ReelCloseMorphProvider({ morph, children }: { morph: ReelCloseMorph; children: ReactNode }) {
  return <ReelCloseMorphContext.Provider value={morph}>{children}</ReelCloseMorphContext.Provider>;
}

/**
 * Cuts the page down at once for a close into the tile of `itemId`, if that
 * tile is laid out and holds the picture: for the reel's own Back, whose pop
 * draws the page from a snapshot taken as it begins. Returns whether it did.
 */
export function startReelCloseMorph(morph: ReelCloseMorph, surfaceId: string | null, itemId: string | null) {
  if (!isAppleZoomReturnPictureHeld(surfaceId, itemId)) return false;
  const shape = appleZoomTileShape(surfaceId, itemId);
  if (!shape) return false;
  morph.tile.value = shape;
  morph.progress.value = 1;
  cutAtOnce.add(morph);
  return true;
}

/**
 * The pages the reel's own Back has cut down at once. The close that follows
 * leaves them as they are (`ReelCloseMorphCue`): the tap on that Back is a
 * finger that left the reel just before the close was heard of, and taken for
 * one dragging the close it had the page follow the progress up from nothing.
 */
const cutAtOnce = new WeakSet<ReelCloseMorph>();

/**
 * How long a page cut down at once is given to be drawn before the pop that
 * snapshots it: the change crosses to the UI thread and waits for a frame.
 */
export const REEL_CLOSE_MORPH_DRAWN_MS = 50;

/** Brings the whole page back. */
export function endReelCloseMorph(morph: ReelCloseMorph) {
  cutAtOnce.delete(morph);
  morph.progress.value = withTiming(0, { duration: REEL_CLOSE_MORPH_BACK_MS, easing: Easing.out(Easing.cubic) });
}

/**
 * Cuts the page down as a close UIKit runs goes on. Draws nothing.
 *
 * A close no finger began (the bar's Back) is cut down at once, in
 * `REEL_CLOSE_MORPH_MS`: the transition's progress reaches JS some 70 ms into
 * such a close, by when the simulator's zoom already has the page at the tile
 * (filmed 2026-11-10).
 *
 * A close a finger began (the edge swipe, a drag down) follows the progress
 * instead, all the way down by `REEL_CLOSE_MORPH_FULL_AT` of it: the progress
 * follows the finger, so a drag thins the page as it pulls the page away, as
 * Photos thins its page under a drag, and nothing here has to know when the
 * finger lifts (React Native loses a touch that UIKit's gesture takes over).
 *
 * Either close, let go of before it commits, brings the page back.
 */
export function ReelCloseMorphCue({
  morph,
  reelId,
  surfaceId,
  itemId,
  touches,
  enabled,
}: {
  morph: ReelCloseMorph;
  /** This reel, for a picture that flies home itself (lib/reel-close-flight.ts). */
  reelId: number;
  /** The surface of the tile the reel closes into, and the post the reader is on. */
  surfaceId: string | null;
  itemId: string | null;
  touches: ReelTouches;
  /** The tile holds this post's picture for the close. */
  enabled: boolean;
}) {
  const navigation = useNavigation();
  const { progress } = useTransitionProgress();
  useEffect(() => {
    if (!enabled || !surfaceId || !itemId) return undefined;
    let progressId: string | null = null;
    let started = false;
    /** Sets the tile the page is cut down to; false when there is none to close into. */
    const begin = () => {
      if (started) return true;
      // Not held (the reel has not landed yet): UIKit closes into another
      // view, lined up another way, and the page stays whole.
      if (!isAppleZoomReturnPictureHeld(surfaceId, itemId)) return false;
      const shape = appleZoomTileShape(surfaceId, itemId);
      if (!shape) return false;
      morph.tile.value = shape;
      started = true;
      return true;
    };
    const follow = (value: number) => {
      const target = reelCloseMorphAt(value);
      if ((!started && target <= 0) || !begin()) return;
      // Each report arrives a frame or two late and a step apart: eased toward,
      // not jumped to.
      morph.progress.value = withTiming(target, { duration: REEL_CLOSE_MORPH_EASE_MS, easing: Easing.out(Easing.quad) });
    };
    const stop = () => {
      if (progressId) progress.removeListener(progressId);
      progressId = null;
    };
    const unsubscribe = listenForScreenLeaving(navigation, (leaving) => {
      // The same event announces a screen pushed over the reel, when the reel
      // is no longer the focused route: nothing is closing then.
      if (leaving && navigation.isFocused()) {
        // The bar's Back, and the picture is flying home on its own over a
        // page already hidden: nothing of the page is left to cut down.
        if (confirmReelCloseFlight(reelId)) return;
        // The reel's own Back, which cut the page down before asking for the pop.
        if (cutAtOnce.has(morph)) return;
        const lifted = touches.endedAt();
        const fingerBegan = touches.active() || (lifted !== null && lifted >= performance.now() - FINGER_LEAD_MS);
        if (fingerBegan) {
          progressId ??= progress.addListener(({ value }) => follow(value));
        } else if (begin()) {
          morph.progress.value = withTiming(1, { duration: REEL_CLOSE_MORPH_MS, easing: Easing.out(Easing.cubic) });
        }
      } else if (!leaving) {
        stop();
        if (started || cutAtOnce.has(morph)) endReelCloseMorph(morph);
        started = false;
      }
    });
    return () => {
      stop();
      unsubscribe();
      // The reader moved to another post mid-close, or the picture stopped
      // being one the tile holds: the page is whole for whatever comes next.
      if (started) morph.progress.value = 0;
    };
  }, [enabled, itemId, morph, navigation, progress, reelId, surfaceId, touches]);
  return null;
}

/**
 * Wraps a slide's picture, drawn across the whole page: trims it to the part
 * the tile shows as the page is cut down. The part is the one UIKit lines the
 * tile up with: the picture's rectangle on the page, cropped about its centre
 * to the tile's shape (Expo Router's `calculateAdjustedRect`), with the tile's
 * corners at the page's scale.
 */
export function ReelCloseMorphClip({
  width,
  height,
  aspectRatio,
  children,
}: {
  width: number;
  height: number;
  /** width / height of the picture as the slide draws it. */
  aspectRatio: number | null | undefined;
  children: ReactNode;
}) {
  const morph = useContext(ReelCloseMorphContext);
  const fallbackProgress = useSharedValue(0);
  const fallbackTile = useSharedValue<AppleZoomTileShape | null>(null);
  const progress = morph?.progress ?? fallbackProgress;
  const tile = morph?.tile ?? fallbackTile;
  const media = mediaRectInScreen({ width, height }, aspectRatio);
  const mediaX = media.x;
  const mediaY = media.y;
  const mediaWidth = media.width;
  const mediaHeight = media.height;

  const clipStyle = useAnimatedStyle(() => {
    const shape = tile.value;
    const t = progress.value;
    if (!shape || t <= 0 || !(mediaWidth > 0 && mediaHeight > 0)) {
      return { left: 0, top: 0, width, height, borderRadius: 0 };
    }
    const tileAspect = shape.width / shape.height;
    let cropX = mediaX;
    let cropY = mediaY;
    let cropWidth = mediaWidth;
    let cropHeight = mediaHeight;
    if (mediaWidth / mediaHeight > tileAspect) {
      cropWidth = mediaHeight * tileAspect;
      cropX = mediaX + (mediaWidth - cropWidth) / 2;
    } else {
      cropHeight = mediaWidth / tileAspect;
      cropY = mediaY + (mediaHeight - cropHeight) / 2;
    }
    return {
      left: cropX * t,
      top: cropY * t,
      width: width + (cropWidth - width) * t,
      height: height + (cropHeight - height) * t,
      borderRadius: shape.radius * (cropWidth / shape.width) * t,
      borderCurve: 'continuous' as const,
    };
  });
  const contentStyle = useAnimatedStyle(() => {
    const shape = tile.value;
    const t = progress.value;
    if (!shape || t <= 0 || !(mediaWidth > 0 && mediaHeight > 0)) return { left: 0, top: 0 };
    const tileAspect = shape.width / shape.height;
    let cropX = mediaX;
    let cropY = mediaY;
    if (mediaWidth / mediaHeight > tileAspect) cropX = mediaX + (mediaWidth - mediaHeight * tileAspect) / 2;
    else cropY = mediaY + (mediaHeight - mediaWidth / tileAspect) / 2;
    return { left: -cropX * t, top: -cropY * t };
  });

  return (
    <Animated.View style={[{ position: 'absolute', overflow: 'hidden', borderCurve: 'continuous' }, clipStyle]}>
      <Animated.View style={[{ position: 'absolute', width, height }, contentStyle]}>
        {children}
      </Animated.View>
    </Animated.View>
  );
}
