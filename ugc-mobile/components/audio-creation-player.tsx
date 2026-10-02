import { Pause, Play, RotateCcw } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, View, type AccessibilityActionEvent, type GestureResponderEvent } from 'react-native';

import { AppText } from '@/components/ui';
import { AUDIO_PROGRESS_INTERVAL_SECONDS } from '@/lib/audio-creation-native-player';
import { formatAudioClock, getAudioProgressFraction } from '@/lib/audio-creation-playback';
import { haptic } from '@/lib/haptics';
import type { ImmersivePreviewAudio } from '@/lib/immersive-preview-view-model';
import { MotionView, usePressMotion, useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { useAudioCreationPlayback } from '@/lib/use-audio-creation-playback';

const SIZES = {
  // A feed card's player sits under a title, beside other cards.
  card: { button: 48, icon: appTheme.icon.feature, track: 4, gap: 12 },
  // The reel's audio page has the whole slide to itself.
  slide: { button: 64, icon: appTheme.icon.hero, track: 6, gap: 16 },
} as const;

/** One step of the position, for a screen reader's swipe up or down. */
const SEEK_STEP = 0.1;

/**
 * The player an audio creation draws where a picture or video would be.
 *
 * It never starts by itself: sound is a tap away and a tap from stopping (HIG,
 * Playing audio). The same creation can be drawn in the Creations feed and in
 * the reel at once; both read one store, so they agree on where it is.
 *
 * Colours come from the theme in scope, so the reel, which stays dark, and a
 * feed card, which follows the phone, each get their own without a flag.
 */
export function AudioCreationPlayer({
  itemId,
  audio,
  label,
  reachable,
  size = 'card',
}: {
  itemId: string;
  audio: ImmersivePreviewAudio;
  /** What the sound is ("Voiceover", "Sound effect"), for the controls' spoken names. */
  label: string;
  /** Whether a person can get at these controls now: screen focused, slide in view. */
  reachable: boolean;
  size?: keyof typeof SIZES;
}) {
  const theme = useAppTheme();
  const metrics = SIZES[size];
  const { snapshot, toggle, seek } = useAudioCreationPlayback({ itemId, url: audio.url, reachable });
  const motion = usePressMotion(false, { scale: appTheme.motion.scale.pressedControl });
  const { phase } = snapshot;
  // Before the file has been opened its length is only known when the run was
  // asked for one (a sound effect's seconds); a voiceover's shows once it loads.
  const durationSeconds = snapshot.durationSeconds ?? audio.durationSeconds;
  const noun = label.toLowerCase();
  const buttonLabel = phase === 'playing' || phase === 'loading'
    ? `Pause ${noun}`
    : phase === 'ended'
      ? `Play ${noun} again`
      : phase === 'error'
        ? `Try playing ${noun} again`
        : `Play ${noun}`;
  const iconColor = theme.colors.onPrimary;

  const playButton = (
    <MotionView style={motion.animatedStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={buttonLabel}
        accessibilityState={{ busy: phase === 'loading' }}
        onBlur={motion.onBlur}
        onFocus={motion.onFocus}
        onPressIn={motion.onPressIn}
        onPressOut={motion.onPressOut}
        onPress={() => {
          haptic.light();
          toggle();
        }}
        style={({ pressed }) => ({
          width: metrics.button,
          height: metrics.button,
          borderRadius: metrics.button / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? theme.colors.primaryFillPressed : theme.colors.primaryFill,
          borderWidth: motion.focused ? theme.state.focus.width : 0,
          borderColor: theme.state.focus.color,
        })}
      >
        {phase === 'loading' ? (
          <ActivityIndicator color={iconColor} />
        ) : phase === 'playing' ? (
          <Pause size={metrics.icon} color={iconColor} fill={iconColor} />
        ) : phase === 'ended' || phase === 'error' ? (
          <RotateCcw size={metrics.icon} color={iconColor} />
        ) : (
          // A triangle's visual centre sits left of its box.
          <Play size={metrics.icon} color={iconColor} fill={iconColor} style={{ marginLeft: 3 }} />
        )}
      </Pressable>
    </MotionView>
  );
  const bar = (
    <AudioProgressBar
      fraction={getAudioProgressFraction({ positionSeconds: snapshot.positionSeconds, durationSeconds })}
      gliding={phase === 'playing' || phase === 'ended'}
      trackHeight={metrics.track}
      positionSeconds={snapshot.positionSeconds}
      durationSeconds={snapshot.durationSeconds}
      label={label}
      onSeek={seek}
    />
  );
  // Tabular figures and a floor on the width: the bar must not twitch as the seconds tick over.
  const clockStyle = { fontVariant: ['tabular-nums' as const], minWidth: 30 };
  const elapsed = (
    <AppText variant="caption" color="muted" numberOfLines={1} style={clockStyle}>
      {formatAudioClock(snapshot.positionSeconds)}
    </AppText>
  );
  const total = durationSeconds ? (
    <AppText variant="caption" color="muted" numberOfLines={1} style={[clockStyle, { textAlign: 'right' }]}>
      {formatAudioClock(durationSeconds)}
    </AppText>
  ) : null;
  const failure = (
    <AppText variant="caption" color="danger" numberOfLines={2}>
      {`This ${noun} could not be played. Tap to try again.`}
    </AppText>
  );

  if (size === 'slide') {
    // A page of its own: the button in the middle, the bar the full width under it.
    return (
      <View style={{ gap: metrics.gap }}>
        <View style={{ alignItems: 'center' }}>{playButton}</View>
        <View>
          {bar}
          {phase === 'error' ? failure : (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              {elapsed}
              {total}
            </View>
          )}
        </View>
      </View>
    );
  }

  // One row, so the bar sits on the button's centre line.
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: metrics.gap }}>
      {playButton}
      {phase === 'error' ? (
        <View style={{ flex: 1, minWidth: 0 }}>{failure}</View>
      ) : (
        <>
          {elapsed}
          <View style={{ flex: 1, minWidth: 0 }}>{bar}</View>
          {total}
        </>
      )}
    </View>
  );
}

/**
 * How far the sound has got, and a tap anywhere along it to move there.
 *
 * The player reports its position four times a second. Drawn as reported, the
 * fill moves in visible steps on a clip a few seconds long, so it glides from
 * one report to the next on the UI thread instead.
 */
function AudioProgressBar({
  fraction,
  gliding,
  trackHeight,
  positionSeconds,
  durationSeconds,
  label,
  onSeek,
}: {
  fraction: number;
  /** Sound is coming out, or has just run to its end: this report continues from the last. */
  gliding: boolean;
  trackHeight: number;
  positionSeconds: number;
  /** The file's own length; null until the player has read it, and nothing can be sought before then. */
  durationSeconds: number | null;
  label: string;
  onSeek: (fraction: number) => void;
}) {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const [progress] = useState(() => new Animated.Value(fraction));
  const lastFraction = useRef(fraction);

  useEffect(() => {
    const previous = lastFraction.current;
    lastFraction.current = fraction;
    // Forward while sound is coming out, or onto the end it just reached: the
    // next report continues from this one, so the fill travels there. Anything
    // else (a seek, a replay, a pause) is a place, not a journey.
    if (gliding && fraction >= previous && !reducedMotion) {
      Animated.timing(progress, {
        toValue: fraction,
        duration: AUDIO_PROGRESS_INTERVAL_SECONDS * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start();
      return;
    }
    // Set from the stop's own callback: a value set while a native-driven
    // animation is still winding down can be overwritten by its last frame.
    progress.stopAnimation(() => progress.setValue(fraction));
  }, [fraction, gliding, progress, reducedMotion]);

  const canSeek = durationSeconds !== null && durationSeconds > 0;
  const seekFromPress = (event: GestureResponderEvent) => {
    if (trackWidth > 0) onSeek(event.nativeEvent.locationX / trackWidth);
  };
  const seekFromAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'increment') onSeek(fraction + SEEK_STEP);
    if (event.nativeEvent.actionName === 'decrement') onSeek(fraction - SEEK_STEP);
  };

  return (
    <Pressable
      accessibilityRole="adjustable"
      accessibilityLabel={`${label} position`}
      accessibilityValue={{
        min: 0,
        max: Math.round(durationSeconds ?? 0),
        now: Math.round(positionSeconds),
        text: canSeek
          ? `${formatAudioClock(positionSeconds)} of ${formatAudioClock(durationSeconds)}`
          : formatAudioClock(positionSeconds),
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      accessibilityState={{ disabled: !canSeek }}
      onAccessibilityAction={seekFromAction}
      disabled={!canSeek}
      onPress={seekFromPress}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
      // The bar is a few points tall; the region that answers a tap is 44.
      style={{ height: appTheme.touch.compact, justifyContent: 'center' }}
    >
      <View
        pointerEvents="none"
        style={{
          height: trackHeight,
          borderRadius: trackHeight / 2,
          overflow: 'hidden',
          backgroundColor: theme.colors.borderStrong,
        }}
      >
        <Animated.View
          style={{
            width: '100%',
            height: '100%',
            borderRadius: trackHeight / 2,
            backgroundColor: theme.colors.primary,
            // Slid in from the left rather than scaled, so its rounded end keeps its shape.
            transform: [{
              translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-trackWidth, 0] }),
            }],
          }}
        />
      </View>
    </Pressable>
  );
}
