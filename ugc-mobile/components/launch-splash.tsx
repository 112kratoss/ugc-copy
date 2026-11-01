import { Image } from 'expo-image';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, Platform, StyleSheet, useColorScheme, useWindowDimensions, View } from 'react-native';

import { releaseNativeAppearance } from '@/lib/appearance';
import {
  endLaunchSplash,
  isLaunchRouteSettled,
  LAUNCH_CLIP_START_TIMEOUT_MS,
  LAUNCH_SPLASH_MAX_MS,
  LAUNCH_STILL_FALLBACK_MS,
  launchSplashGround,
  launchSplashIconSize,
  shouldRevealApp,
  subscribeLaunchSplash,
  type LaunchClip,
} from '@/lib/launch-splash';
import { useReducedMotion } from '@/lib/motion';

import splashIcon from '../assets/images/splash-icon.png';
import stingDark from '../assets/video/splash-sting-dark.mp4';
import stingLight from '../assets/video/splash-sting-light.mp4';

const FADE_OUT_MS = 220;

/**
 * Then, with the native splash gone, a stored Appearance choice may reach the
 * native layer: any earlier, it redraws the native splash in that scheme.
 */
function hideNativeSplash() {
  void SplashScreen.hideAsync().catch(() => undefined).finally(releaseNativeAppearance);
}

/**
 * The launch sting over the app's first moments (lib/launch-splash.ts has the
 * rules). Drawn last in the root layout, so it sits above every screen.
 */
export function LaunchSplash({ shellReady }: { shellReady: boolean }) {
  return Platform.OS === 'ios' || Platform.OS === 'android'
    ? <LaunchSting shellReady={shellReady} />
    : <NoLaunchSting />;
}

/** Elsewhere there is no native splash to continue: let go at once. */
function NoLaunchSting() {
  useEffect(() => {
    hideNativeSplash();
    endLaunchSplash();
  }, []);
  return null;
}

function LaunchSting({ shellReady }: { shellReady: boolean }) {
  // The native splash is drawn in the window's scheme: the phone's, since a
  // choice under Settings → Appearance waits for it to go (lib/appearance.ts).
  // The overlay follows the same reading until it takes over, and then holds
  // it: from there the choice belongs to the app beneath, which the overlay
  // fades into.
  const nativeScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const [heldScheme, setHeldScheme] = useState<'light' | 'dark' | null>(null);
  const scheme = heldScheme ?? nativeScheme;
  const [opacity] = useState(() => new Animated.Value(1));
  const reducedMotion = useReducedMotion();
  const iconSize = launchSplashIconSize(Platform.OS, useWindowDimensions());
  const routeSettled = useSyncExternalStore(subscribeLaunchSplash, isLaunchRouteSettled, isLaunchRouteSettled);
  const [stillDrawn, setStillDrawn] = useState(false);
  const [clip, setClip] = useState<LaunchClip>('waiting');
  const [clipDrawn, setClipDrawn] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [gone, setGone] = useState(false);

  const player = useVideoPlayer(scheme === 'dark' ? stingDark : stingLight, (instance) => {
    instance.loop = false;
    instance.muted = true;
    instance.volume = 0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
    // Silent by construction, so it stays out of the audio session and music
    // already playing carries on (as the feed's previews do).
    instance.audioMixingMode = 'auto';
  });

  // The native splash comes down once the still has taken its place, pixel for
  // pixel. A still that never reports itself drawn must not hold it up.
  useEffect(() => {
    if (stillDrawn) {
      setHeldScheme((held) => held ?? nativeScheme);
      hideNativeSplash();
      return;
    }
    const fallback = setTimeout(() => setStillDrawn(true), LAUNCH_STILL_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [nativeScheme, stillDrawn]);

  // Then the clip plays over the still, which is its own first frame.
  useEffect(() => {
    if (!stillDrawn || clip !== 'waiting') return;
    if (reducedMotion) {
      setClip('skipped');
      return;
    }
    player.play();
    setClip('playing');
  }, [clip, player, reducedMotion, stillDrawn]);

  // A clip that has not drawn its first frame soon after being asked to play
  // gives way to the still; it must not start late, mid-fade.
  useEffect(() => {
    if (clip !== 'playing' || clipDrawn) return;
    const timer = setTimeout(() => {
      player.pause();
      setClip('skipped');
    }, LAUNCH_CLIP_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [clip, clipDrawn, player]);

  useEffect(() => {
    const ended = player.addListener('playToEnd', () => setClip('ended'));
    const status = player.addListener('statusChange', ({ status: next }) => {
      if (next === 'error') setClip((current) => (current === 'ended' ? current : 'skipped'));
    });
    return () => {
      ended.remove();
      status.remove();
    };
  }, [player]);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), LAUNCH_SPLASH_MAX_MS);
    return () => clearTimeout(timer);
  }, []);

  const reveal = shouldRevealApp({ clip, routeSettled, shellReady, timedOut });
  useEffect(() => {
    if (!reveal) return;
    hideNativeSplash();
    Animated.timing(opacity, {
      toValue: 0,
      duration: reducedMotion ? 0 : FADE_OUT_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => setGone(true));
  }, [opacity, reducedMotion, reveal]);

  useEffect(() => {
    if (gone) endLaunchSplash();
  }, [gone]);

  if (gone) return null;

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents={reveal ? 'none' : 'auto'}
      style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: launchSplashGround(scheme), opacity }]}
    >
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {/* Centred on the whole screen, as the native splash centres it: the
          root view reaches under the system bars on both platforms. */}
      <View style={{ width: iconSize, height: iconSize }}>
        <Image
          source={splashIcon}
          contentFit="contain"
          transition={0}
          onDisplay={() => setStillDrawn(true)}
          style={StyleSheet.absoluteFill}
        />
        {/* Gone once the clip is: its last half-second is the still beneath
            it, and on Android a video surface does not fade with its parent
            — left in, it flashed black over the app as the overlay faded. */}
        {clip === 'waiting' || clip === 'playing' ? (
          <VideoView
            player={player}
            contentFit="contain"
            nativeControls={false}
            allowsPictureInPicture={false}
            startsPictureInPictureAutomatically={false}
            allowsVideoFrameAnalysis={false}
            fullscreenOptions={{ enable: false }}
            // Android: a texture view keeps the still visible until the first
            // frame, where a surface view and ExoPlayer's shutter draw black.
            surfaceType="textureView"
            useExoShutter={false}
            onFirstFrameRender={() => setClipDrawn(true)}
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, styles.clip]}
          />
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { zIndex: 1000, alignItems: 'center', justifyContent: 'center' },
  clip: { backgroundColor: 'transparent' },
});
