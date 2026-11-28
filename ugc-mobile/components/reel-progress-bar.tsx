import type { VideoPlayer } from 'expo-video';
import { createContext, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Text, View, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';
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
import { REEL_TEXT_SHADOW } from '@/components/reel-chrome';
import { useReducedMotion } from '@/lib/motion';
import {
  REEL_PROGRESS_LINE_HEIGHT,
  REEL_PROGRESS_LINE_HELD_HEIGHT,
  REEL_PROGRESS_SIDE_INSET,
  REEL_SCRUB_ACTIVATE_DISTANCE,
  reelAccessibilityStepSeconds,
  reelProgressAccessibilityText,
  reelProgressFraction,
  reelProgressFrame,
  reelProgressNeedsResync,
  reelScrubDecision,
  reelScrubFraction,
  reelScrubLabel,
  reelSeekSeconds,
  type ReelProgressRun,
} from '@/lib/reel-progress-view-model';
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
 * Built here rather than taken from the player: expo-video's native controls
 * answer their own touches and fight the reel's swipe and double tap on
 * Android (`.claude/rules/mobile-runtime.md`), and bring their whole control
 * strip with them, and no native slider is in the binaries people have. What
 * is native is the seeking: expo-video's scrubbing mode (Apple's chase-time
 * seeking on iOS, ExoPlayer's scrubbing mode on Android) while the finger
 * moves, then one exact seek where it lets go. The line moves on the UI
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

/** Whether the slide's bar is being dragged; false with no store. */
export function useReelScrubbing(store: ReelVideoScrubberStore | null): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store ? () => store.getSnapshot().scrubbing : no,
  );
}

/** Whether the clip is on its way back to playing after a scrub; false with no store. */
export function useReelResuming(store: ReelVideoScrubberStore | null): boolean {
  return useSyncExternalStore(
    store ? store.subscribe : noSubscription,
    store ? () => store.getSnapshot().resuming : no,
  );
}

/** The rail and caption step aside while the bar is dragged, so the whole frame shows. */
export function ReelScrubChromeFade({ store, children }: { store: ReelVideoScrubberStore; children: ReactNode }) {
  const scrubbing = useReelScrubbing(store);
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withTiming(scrubbing ? 0 : 1, {
      duration: reducedMotion ? 0 : scrubbing ? 120 : 220,
      easing: Easing.out(Easing.quad),
    });
  }, [opacity, reducedMotion, scrubbing]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Reanimated.View pointerEvents="box-none" style={[{ position: 'absolute', inset: 0 }, style]}>
      {children}
    </Reanimated.View>
  );
}

/** Exact seeks, as the player starts with; the scrub loosens them while the finger moves. */
const EXACT_SEEK = { toleranceBefore: 0, toleranceAfter: 0 };
const SCRUB_SEEK = { toleranceBefore: 0.1, toleranceAfter: 0.1 };
/** A load right after a seek is the reader's doing, not a stall. */
export const REEL_SEEK_LOAD_WINDOW_MS = 1500;
/** How long a clip let go of mid-scrub has to play again before its pause counts as a stop. */
const RESUME_GRACE_MS = 2500;
/** After a seek, time reports from before it are ignored until one lands this near the new place... */
const SEEK_SETTLE_SECONDS = 0.5;
/** ...or this long has passed. */
const SEEK_SETTLE_MS = 1000;
const THUMB_SIZE = 14;

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

  const durationRef = useRef(0);
  const runRef = useRef<ReelProgressRun | null>(null);
  const pendingSeekRef = useRef<{ seconds: number; until: number } | null>(null);
  const scrubRef = useRef<{ wasPlaying: boolean } | null>(null);
  // Where the clip was last reported or sent, in seconds. Reading `currentTime`
  // on Android blocks the JS thread on the main thread (expo-video's
  // VideoModule.kt), which a scrub keeps busy, so it is read once per player.
  const positionRef = useRef(0);
  // A scrub sends at most one seek a frame: the finger's latest place.
  const scrubTargetRef = useRef(0);
  const scrubFrameRef = useRef<number | null>(null);
  // Ends the wait for a clip let go of mid-scrub to play again.
  const resumeRef = useRef<(() => void) | null>(null);
  const tracksClockRef = useRef(false);
  useEffect(() => {
    durationRef.current = durationSeconds;
  }, [durationSeconds]);
  useEffect(() => {
    tracksClockRef.current = screenReader;
  }, [screenReader]);

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
    shown.value = withTiming(interactive ? 1 : 0, { duration: reducedMotion ? 0 : 160, easing: Easing.out(Easing.quad) });
  }, [interactive, reducedMotion, shown]);

  // Follows the player: a run to the clip's end at its pace while it plays,
  // the exact place while it does not, set back only when a report disagrees.
  useEffect(() => {
    if (!player || !(durationSeconds > 0)) return;
    runRef.current = null;
    positionRef.current = player.currentTime;
    const sync = (reportedSeconds: number) => {
      if (store.getSnapshot().scrubbing) return;
      const now = Date.now();
      const pending = pendingSeekRef.current;
      if (pending) {
        if (now < pending.until && Math.abs(reportedSeconds - pending.seconds) > SEEK_SETTLE_SECONDS) return;
        pendingSeekRef.current = null;
      }
      if (tracksClockRef.current) setClockSeconds(Math.floor(reportedSeconds));
      const fraction = reelProgressFraction(reportedSeconds, durationSeconds);
      if (!player.playing || player.status !== 'readyToPlay') {
        runRef.current = null;
        cancelAnimation(progress);
        progress.value = fraction;
        return;
      }
      if (!reelProgressNeedsResync(runRef.current, now, fraction, durationSeconds)) return;
      const rate = player.playbackRate > 0 ? player.playbackRate : 1;
      const remainingMs = Math.max(0, ((durationSeconds - reportedSeconds) * 1000) / rate);
      runRef.current = { from: fraction, startedAt: now, durationMs: remainingMs };
      progress.value = fraction;
      progress.value = withTiming(1, { duration: remainingMs, easing: Easing.linear });
    };
    const resync = () => {
      if (store.getSnapshot().scrubbing) return;
      runRef.current = null;
      sync(positionRef.current);
    };
    resync();
    const subscriptions = [
      player.addListener('timeUpdate', (event) => {
        positionRef.current = event.currentTime;
        sync(event.currentTime);
      }),
      player.addListener('playingChange', resync),
      player.addListener('statusChange', resync),
    ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
      cancelAnimation(progress);
      runRef.current = null;
    };
  }, [durationSeconds, player, progress, store]);

  const seekTo = useCallback((target: VideoPlayer, seconds: number) => {
    target.currentTime = seconds;
    positionRef.current = seconds;
    runRef.current = null;
    pendingSeekRef.current = { seconds, until: Date.now() + SEEK_SETTLE_MS };
    store.noteSeek(Date.now());
    setClockSeconds(Math.floor(seconds));
  }, [store]);

  const beginScrub = useCallback((fraction: number) => {
    const target = store.getSnapshot().player;
    if (!target) return;
    // A scrub begun while the last one's clip was still coming back plays it on.
    const resuming = resumeRef.current !== null;
    resumeRef.current?.();
    scrubRef.current = { wasPlaying: target.playing || resuming };
    runRef.current = null;
    target.pause();
    target.seekTolerance = SCRUB_SEEK;
    target.scrubbingModeOptions = { scrubbingModeEnabled: true };
    // The clip and the label go to the finger at once, not at its next move.
    const seconds = reelSeekSeconds(fraction, durationRef.current);
    target.currentTime = seconds;
    positionRef.current = seconds;
    setClockSeconds(Math.floor(seconds));
    store.setScrubbing(true);
  }, [store]);

  const applyScrub = useCallback(() => {
    scrubFrameRef.current = null;
    const target = store.getSnapshot().player;
    if (!target || !scrubRef.current) return;
    const seconds = reelSeekSeconds(scrubTargetRef.current, durationRef.current);
    target.currentTime = seconds;
    positionRef.current = seconds;
    setClockSeconds(Math.floor(seconds));
  }, [store]);

  const scrubTo = useCallback((fraction: number) => {
    scrubTargetRef.current = fraction;
    if (scrubFrameRef.current !== null) return;
    scrubFrameRef.current = requestAnimationFrame(applyScrub);
  }, [applyScrub]);

  const endScrub = useCallback((fraction: number) => {
    if (scrubFrameRef.current !== null) {
      cancelAnimationFrame(scrubFrameRef.current);
      scrubFrameRef.current = null;
    }
    const scrub = scrubRef.current;
    scrubRef.current = null;
    const target = store.getSnapshot().player;
    if (!target || !scrub) {
      store.setScrubbing(false);
      return;
    }
    target.scrubbingModeOptions = { scrubbingModeEnabled: false };
    target.seekTolerance = EXACT_SEEK;
    seekTo(target, reelSeekSeconds(fraction, durationRef.current));
    store.setScrubbing(false);
    if (!scrub.wasPlaying) return;
    // It loads at the new place before it plays, and says it is not playing
    // meanwhile: until it plays again, or the grace runs out, that is the scrub's.
    store.setResuming(true);
    let subscription: { remove: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      subscription?.remove();
      if (timer !== null) clearTimeout(timer);
      if (resumeRef.current === finish) resumeRef.current = null;
      store.setResuming(false);
    };
    subscription = target.addListener('playingChange', (event) => {
      if (event.isPlaying) finish();
    });
    timer = setTimeout(finish, RESUME_GRACE_MS);
    resumeRef.current = finish;
    target.play();
  }, [seekTo, store]);

  const tapSeek = useCallback((fraction: number) => {
    const target = store.getSnapshot().player;
    if (!target || scrubRef.current) return;
    seekTo(target, reelSeekSeconds(fraction, durationRef.current));
  }, [seekTo, store]);

  // A bar taken from under a finger (the post scrolled on, the clip failed)
  // leaves its player as it found it.
  useEffect(() => () => {
    if (scrubFrameRef.current !== null) {
      cancelAnimationFrame(scrubFrameRef.current);
      scrubFrameRef.current = null;
    }
    resumeRef.current?.();
    const scrub = scrubRef.current;
    if (!scrub || !player) return;
    scrubRef.current = null;
    player.scrubbingModeOptions = { scrubbingModeEnabled: false };
    player.seekTolerance = EXACT_SEEK;
  }, [player]);

  const holdDuration = reducedMotion ? 0 : 90;
  const releaseDuration = reducedMotion ? 0 : 180;
  // Made once per change of what it reads, not per render: the scrub label
  // re-renders the bar while a finger is on it.
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .enabled(interactive)
      .manualActivation(true)
      .maxPointers(1)
      .onTouchesDown((event) => {
        'worklet';
        const touch = event.allTouches[0];
        if (!touch) return;
        startX.value = touch.absoluteX;
        startY.value = touch.absoluteY;
        decided.value = false;
        held.value = withTiming(1, { duration: holdDuration, easing: Easing.out(Easing.quad) });
      })
      .onTouchesMove((event, manager) => {
        'worklet';
        if (decided.value) return;
        const touch = event.allTouches[0];
        if (!touch) return;
        const decision = reelScrubDecision(touch.absoluteX - startX.value, touch.absoluteY - startY.value);
        if (decision === 'scrub') {
          decided.value = true;
          manager.activate();
        } else if (decision === 'pass') {
          decided.value = true;
          manager.fail();
        }
      })
      .onStart((event) => {
        'worklet';
        dragging.value = true;
        cancelAnimation(progress);
        const fraction = reelScrubFraction(event.x - REEL_PROGRESS_SIDE_INSET, trackWidth.value);
        progress.value = fraction;
        runOnJS(beginScrub)(fraction);
      })
      .onUpdate((event) => {
        'worklet';
        const fraction = reelScrubFraction(event.x - REEL_PROGRESS_SIDE_INSET, trackWidth.value);
        if (fraction === progress.value) return;
        progress.value = fraction;
        runOnJS(scrubTo)(fraction);
      })
      .onEnd(() => {
        'worklet';
        if (!dragging.value) return;
        dragging.value = false;
        runOnJS(endScrub)(progress.value);
      })
      .onFinalize(() => {
        'worklet';
        held.value = withTiming(0, { duration: releaseDuration, easing: Easing.out(Easing.quad) });
      });
    const tap = Gesture.Tap()
      .enabled(interactive)
      .maxDuration(400)
      .maxDistance(REEL_SCRUB_ACTIVATE_DISTANCE)
      .onEnd((event, success) => {
        'worklet';
        if (!success) return;
        const fraction = reelScrubFraction(event.x - REEL_PROGRESS_SIDE_INSET, trackWidth.value);
        cancelAnimation(progress);
        progress.value = fraction;
        runOnJS(tapSeek)(fraction);
      });
    return Gesture.Race(pan, tap);
  }, [beginScrub, decided, dragging, endScrub, held, holdDuration, interactive, progress, releaseDuration, scrubTo, startX, startY, tapSeek, trackWidth]);

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    trackWidth.value = event.nativeEvent.layout.width;
  }, [trackWidth]);

  const onAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    const target = store.getSnapshot().player;
    const duration = durationRef.current;
    if (!target || !(duration > 0)) return;
    const step = reelAccessibilityStepSeconds(duration);
    const name = event.nativeEvent.actionName;
    if (name !== 'increment' && name !== 'decrement') return;
    const next = positionRef.current + (name === 'increment' ? step : -step);
    const seconds = reelSeekSeconds(reelProgressFraction(next, duration), duration);
    cancelAnimation(progress);
    progress.value = reelProgressFraction(seconds, duration);
    seekTo(target, seconds);
  }, [progress, seekTo, store]);

  const barStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const lineStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: 1 + held.value * (REEL_PROGRESS_LINE_HELD_HEIGHT / REEL_PROGRESS_LINE_HEIGHT - 1) }],
  }));
  const playedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.value - 1) * trackWidth.value }],
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    opacity: held.value,
    transform: [{ translateX: progress.value * trackWidth.value }, { scale: 0.5 + held.value * 0.5 }],
  }));

  const lineBoxHeight = REEL_PROGRESS_LINE_HELD_HEIGHT;
  return (
    <Reanimated.View
      pointerEvents={interactive ? 'box-none' : 'none'}
      style={[{ position: 'absolute', left: 0, right: 0, bottom: frame.bottom, height: frame.height }, barStyle]}
    >
      {scrubbing ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: frame.height + 8, alignItems: 'center' }}>
          <Text style={{ color: mediaColors.onMedia, ...appTheme.type.body, fontWeight: '700', fontVariant: ['tabular-nums'], ...REEL_TEXT_SHADOW }}>
            {reelScrubLabel(clockSeconds, durationSeconds)}
          </Text>
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
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={onAccessibilityAction}
          style={{ flex: 1, paddingHorizontal: REEL_PROGRESS_SIDE_INSET }}
        >
          <View
            onLayout={onTrackLayout}
            style={{ position: 'absolute', left: REEL_PROGRESS_SIDE_INSET, right: REEL_PROGRESS_SIDE_INSET, bottom: frame.lineCenter - lineBoxHeight / 2, height: lineBoxHeight, justifyContent: 'center' }}
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
                top: (lineBoxHeight - THUMB_SIZE) / 2,
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
