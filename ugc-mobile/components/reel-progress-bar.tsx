import type { VideoPlayer } from 'expo-video';
import { createContext, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { View, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useScreenReaderRunning } from '@/components/notice-card';
import { AppText } from '@/components/ui';
import { useReducedMotion } from '@/lib/motion';
import {
  REEL_PROGRESS_END_SLOP,
  REEL_PROGRESS_LINE_HEIGHT,
  REEL_PROGRESS_LINE_HELD_HEIGHT,
  REEL_SCRUB_ACTIVATE_DISTANCE,
  reelProgressAccessibilityText,
  reelProgressFrame,
  reelScrubDecision,
  reelScrubFraction,
  reelScrubLabel,
} from '@/lib/reel-progress-view-model';
import { createReelScrubController } from '@/lib/reel-scrub-controller';
import { createReelScrubberStore, type ReelScrubberStore } from '@/lib/reel-scrubber-store';
import { appTheme, mediaColors } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * The reel's progress bar: a thin coral line under the caption of the video
 * playing on a slide. A sideways drag scrubs the clip, a tap seeks it, and a
 * swipe up or down that starts on it still moves the reel. Drawn with the
 * slide's chrome (`app/viewer.tsx`), so it slides away to Details with the
 * rail and caption; the playing page hands it its player through
 * `ReelScrubberContext` (`lib/reel-scrubber-store.ts`).
 *
 * Why it is drawn here, after checking the native controls first:
 * - expo-video's native controls answer their own touches and fight the
 *   reel's swipe and double tap on Android (`.claude/rules/mobile-runtime.md`),
 *   and bring their whole control strip with them.
 * - @expo/ui 55's Slider (SwiftUI's and Compose's) is in the binaries, but it
 *   is the system control: a full-height track with its thumb always showing,
 *   not a hairline under the caption that thickens under a finger, and a
 *   native view of its own answering touches inside the reel's lists.
 * What is native is the seeking: expo-video's scrubbing mode (Apple's
 * chase-time seeking on iOS, ExoPlayer's scrubbing mode on Android) while the
 * finger moves, then one exact seek where it lets go. The line moves on the UI
 * thread: it runs to the clip's end at the clip's pace and is checked against
 * the player's time reports, four a second.
 */

export type ReelVideoScrubberStore = ReelScrubberStore<VideoPlayer>;

export const ReelScrubberContext = createContext<ReelVideoScrubberStore | null>(null);

/** One store per reel slide, made once. */
export function useReelScrubberStore(): ReelVideoScrubberStore {
  const [store] = useState(() => createReelScrubberStore<VideoPlayer>());
  return store;
}

const noSubscription = () => () => {};
const no = () => false;

/** Whether a finger is dragging the slide's bar, whatever it plays; false with no store. */
export function useReelScrubbing(store: ReelVideoScrubberStore | null): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store ? () => store.getSnapshot().scrubbing : no,
  );
}

/** Whether the bar is dragging this player's clip. */
export function useReelScrubbingFor(store: ReelVideoScrubberStore | null, player: VideoPlayer): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store ? () => store.getSnapshot().player === player && store.getSnapshot().scrubbing : no,
  );
}

/** Whether this player's clip is on its way back to playing after the bar moved it. */
export function useReelResumingFor(store: ReelVideoScrubberStore | null, player: VideoPlayer): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store ? () => store.getSnapshot().player === player && store.getSnapshot().resuming : no,
  );
}

/** The rail and caption step aside while the bar is dragged, so the whole frame shows. */
export function ReelScrubChromeFade({ store, children }: { store: ReelVideoScrubberStore; children: ReactNode }) {
  const scrubbing = useReelScrubbing(store);
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(withTiming(scrubbing ? 0 : 1, {
      duration: reducedMotion ? 0 : scrubbing ? 120 : 220,
      easing: Easing.out(Easing.quad),
    }));
  }, [opacity, reducedMotion, scrubbing]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Reanimated.View pointerEvents="box-none" style={[{ position: 'absolute', inset: 0 }, style]}>
      {children}
    </Reanimated.View>
  );
}

/** A load right after a seek is the reader's doing, not a stall. */
export const REEL_SEEK_LOAD_WINDOW_MS = 1500;
const THUMB_SIZE = 14;
const LINE_BOX_HEIGHT = REEL_PROGRESS_LINE_HELD_HEIGHT;
const SCRUB_ACCESSIBILITY_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }];

export function ReelProgressBar({ store, bottomInset }: { store: ReelVideoScrubberStore; bottomInset: number }) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const screenReader = useScreenReaderRunning();
  const { player, scrubbing } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [durationSeconds, setDurationSeconds] = useState(0);
  // Whole seconds only: what the scrub label and a screen reader say.
  const [clockSeconds, setClockSeconds] = useState(0);
  const interactive = Boolean(player) && durationSeconds > 0;
  const frame = reelProgressFrame(bottomInset);

  const progress = useSharedValue(0);
  const held = useSharedValue(0);
  const shown = useSharedValue(0);
  const trackWidth = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const decided = useSharedValue(false);
  const dragging = useSharedValue(false);

  // Everything the bar does with the player (`lib/reel-scrub-controller.ts`),
  // made once for this slide's store. It draws through the line below.
  const [controller] = useState(() => createReelScrubController<VideoPlayer>({
    store,
    line: {
      setFraction(fraction) {
        cancelAnimation(progress);
        progress.set(fraction);
      },
      runToEnd(fraction, durationMs) {
        progress.set(fraction);
        progress.set(withTiming(1, { duration: durationMs, easing: Easing.linear }));
      },
    },
    setClock: setClockSeconds,
  }));
  useEffect(() => {
    controller.setDuration(durationSeconds);
  }, [controller, durationSeconds]);
  useEffect(() => {
    controller.setTracksClock(screenReader);
  }, [controller, screenReader]);

  // The clip's length, once its source has loaded.
  useEffect(() => {
    if (!player) {
      setDurationSeconds(0);
      return;
    }
    const read = () => {
      const duration = player.duration;
      setDurationSeconds(Number.isFinite(duration) && duration > 0 ? duration : 0);
    };
    read();
    const subscriptions = [player.addListener('sourceLoad', read), player.addListener('statusChange', read)];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [player]);

  useEffect(() => {
    shown.set(withTiming(interactive ? 1 : 0, { duration: reducedMotion ? 0 : 160, easing: Easing.out(Easing.quad) }));
  }, [interactive, reducedMotion, shown]);

  // Follows the player: a run to the clip's end at its pace while it plays,
  // the exact place while it does not, set back only when a report disagrees.
  useEffect(() => {
    if (!player || !(durationSeconds > 0)) return;
    controller.follow();
    const subscriptions = [
      player.addListener('timeUpdate', (event) => controller.report(player, event.currentTime)),
      player.addListener('playingChange', () => controller.resync(player)),
      player.addListener('statusChange', () => controller.resync(player)),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
      cancelAnimation(progress);
    };
  }, [controller, durationSeconds, player, progress]);

  // A bar taken from under a finger (the post scrolled on, the clip failed)
  // leaves its player as it found it.
  useEffect(() => () => controller.release(player), [controller, player]);

  const holdDuration = reducedMotion ? 0 : 90;
  const releaseDuration = reducedMotion ? 0 : 180;
  // Made once per change of what it reads, not per render: the scrub label
  // re-renders the bar while a finger is on it. Shared values are read and
  // written with get and set, and the JS side is the controller's, so React
  // Compiler compiles the bar.
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .enabled(interactive)
      .manualActivation(true)
      .maxPointers(1)
      .onTouchesDown((event) => {
        'worklet';
        const touch = event.allTouches[0];
        if (!touch) return;
        startX.set(touch.absoluteX);
        startY.set(touch.absoluteY);
        decided.set(false);
        held.set(withTiming(1, { duration: holdDuration, easing: Easing.out(Easing.quad) }));
      })
      .onTouchesMove((event, manager) => {
        'worklet';
        if (decided.get()) return;
        const touch = event.allTouches[0];
        if (!touch) return;
        const decision = reelScrubDecision(touch.absoluteX - startX.get(), touch.absoluteY - startY.get());
        if (decision === 'scrub') {
          decided.set(true);
          manager.activate();
        } else if (decision === 'pass') {
          decided.set(true);
          manager.fail();
        }
      })
      .onStart((event) => {
        'worklet';
        dragging.set(true);
        cancelAnimation(progress);
        const fraction = reelScrubFraction(event.x - REEL_PROGRESS_END_SLOP, trackWidth.get());
        progress.set(fraction);
        runOnJS(controller.beginScrub)(fraction);
      })
      .onUpdate((event) => {
        'worklet';
        const fraction = reelScrubFraction(event.x - REEL_PROGRESS_END_SLOP, trackWidth.get());
        if (fraction === progress.get()) return;
        progress.set(fraction);
        runOnJS(controller.scrubTo)(fraction);
      })
      .onEnd(() => {
        'worklet';
        if (!dragging.get()) return;
        dragging.set(false);
        runOnJS(controller.endScrub)(progress.get());
      })
      .onFinalize(() => {
        'worklet';
        held.set(withTiming(0, { duration: releaseDuration, easing: Easing.out(Easing.quad) }));
      });
    const tap = Gesture.Tap()
      .enabled(interactive)
      .maxDuration(400)
      .maxDistance(REEL_SCRUB_ACTIVATE_DISTANCE)
      .onEnd((event, success) => {
        'worklet';
        if (!success) return;
        const fraction = reelScrubFraction(event.x - REEL_PROGRESS_END_SLOP, trackWidth.get());
        cancelAnimation(progress);
        progress.set(fraction);
        runOnJS(controller.tapSeek)(fraction);
      });
    return Gesture.Race(pan, tap);
  }, [controller, decided, dragging, held, holdDuration, interactive, progress, releaseDuration, startX, startY, trackWidth]);

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    trackWidth.set(event.nativeEvent.layout.width);
  }, [trackWidth]);

  const onAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    // A double tap activates the bar, which does nothing: without its own
    // activate, iOS and Android would tap its middle for it, a seek to 50%.
    if (name === 'increment') controller.step(1);
    else if (name === 'decrement') controller.step(-1);
  }, [controller]);

  const barStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const lineStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: 1 + held.get() * (REEL_PROGRESS_LINE_HELD_HEIGHT / REEL_PROGRESS_LINE_HEIGHT - 1) }],
  }));
  const playedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.get() - 1) * trackWidth.get() }],
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    opacity: held.get(),
    transform: [{ translateX: progress.get() * trackWidth.get() }, { scale: 0.5 + held.get() * 0.5 }],
  }));

  return (
    <Reanimated.View
      pointerEvents={interactive ? 'box-none' : 'none'}
      style={[{ position: 'absolute', left: 0, right: 0, bottom: frame.bottom, height: frame.height }, barStyle]}
    >
      {/* The rail and caption fade with their shade while the bar is dragged,
          so the time sits on a shade of its own. */}
      {scrubbing ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: frame.height + 8, alignItems: 'center' }}>
          <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: mediaColors.mediaChip, paddingHorizontal: 12, paddingVertical: 4 }}>
            <AppText variant="button" color={mediaColors.onMedia} style={{ fontVariant: ['tabular-nums'] }}>
              {reelScrubLabel(clockSeconds, durationSeconds)}
            </AppText>
          </View>
        </View>
      ) : null}
      <GestureDetector gesture={gesture}>
        <View
          collapsable={false}
          accessible={interactive}
          accessibilityRole="adjustable"
          accessibilityLabel="Video progress"
          // Never back to undefined, which Android would not clear (hig-accessibility-label-states).
          accessibilityValue={{ text: interactive ? reelProgressAccessibilityText(clockSeconds, durationSeconds) : '' }}
          accessibilityActions={SCRUB_ACCESSIBILITY_ACTIONS}
          onAccessibilityAction={onAccessibilityAction}
          // The line and a finger's width past either end, clear of the edge swipes.
          style={{ position: 'absolute', top: 0, bottom: 0, left: frame.side, right: frame.side }}
        >
          <View
            onLayout={onTrackLayout}
            style={{ position: 'absolute', left: REEL_PROGRESS_END_SLOP, right: REEL_PROGRESS_END_SLOP, bottom: frame.lineCenter - LINE_BOX_HEIGHT / 2, height: LINE_BOX_HEIGHT, justifyContent: 'center' }}
          >
            <Reanimated.View
              style={[{ height: REEL_PROGRESS_LINE_HEIGHT, borderRadius: REEL_PROGRESS_LINE_HEIGHT / 2, overflow: 'hidden', backgroundColor: mediaColors.mediaTrack }, lineStyle]}
            >
              <Reanimated.View style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: theme.colors.primary }, playedStyle]} />
            </Reanimated.View>
            <Reanimated.View
              pointerEvents="none"
              style={[{
                position: 'absolute',
                left: -THUMB_SIZE / 2,
                top: (LINE_BOX_HEIGHT - THUMB_SIZE) / 2,
                width: THUMB_SIZE,
                height: THUMB_SIZE,
                borderRadius: THUMB_SIZE / 2,
                backgroundColor: mediaColors.onMedia,
              }, thumbStyle]}
            />
          </View>
        </View>
      </GestureDetector>
    </Reanimated.View>
  );
}
