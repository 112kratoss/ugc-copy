import { Image } from 'expo-image';
import { usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Animated, Appearance, Easing, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

import { releaseNativeAppearance } from '@/lib/appearance';
import { FEED_VIDEO_VIEW_PROPS } from '@/lib/feed-video-view-props';
import {
  endLaunchSplash,
  isLaunchRouteSettled,
  isLaunchSplashCovering,
  LAUNCH_CLIP_DEADLINE_MS,
  LAUNCH_SPLASH_MAX_MS,
  LAUNCH_STILL_FALLBACK_MS,
  launchSplashGround,
  launchSplashIconSize,
  shouldRevealApp,
  subscribeLaunchSplash,
  type LaunchClip,
} from '@/lib/launch-splash';
import { useReducedMotionAnswer } from '@/lib/motion';
import { reportStartupMilestone } from '@/lib/startup-interactive';
import { useNavigationBarSurface } from '@/lib/system-bars';
import type { ColorScheme } from '@/lib/theme';

import splashIcon from '../assets/images/splash-icon.png';
import stingDark from '../assets/video/splash-sting-dark.mp4';
import stingLight from '../assets/video/splash-sting-light.mp4';

const FADE_OUT_MS = 220;
/** An answer to "is Reduce Motion on?" slower than this is taken as no. */
const MOTION_READ_FALLBACK_MS = 500;

function hideNativeSplash() {
  void SplashScreen.hideAsync().catch(() => undefined);
}

/**
 * The phone's scheme, read once: the native splash is drawn in it, and a choice
 * under Settings → Appearance reaches the native layer only as this overlay
 * leaves (lib/appearance.ts), so nothing can move it before then.
 */
function readPhoneScheme(): ColorScheme {
  return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
}

type MotionPreference = 'unknown' | 'full' | 'reduced';

/**
 * Reduce Motion as an answer, not a stand-in: `useReducedMotion()` reads "no"
 * until the platform replies, and a still already in the image cache can be
 * drawn before it does, which would start the clip for someone who asked for
 * none. No reply in MOTION_READ_FALLBACK_MS is taken as no.
 */
function useLaunchMotion(): MotionPreference {
  const answer = useReducedMotionAnswer();
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (answer !== null) return;
    const fallback = setTimeout(() => setGaveUp(true), MOTION_READ_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [answer]);
  if (answer === null) return gaveUp ? 'full' : 'unknown';
  return answer ? 'reduced' : 'full';
}

/**
 * The launch sting over the app's first moments (lib/launch-splash.ts has the
 * rules). Rendered last in the root layout, outside the app's own views, so it
 * sits above everything, StartupCoordinator's cover included.
 */
export function LaunchSplash({ shellReady }: { shellReady: boolean }) {
  const covering = useSyncExternalStore(subscribeLaunchSplash, isLaunchSplashCovering, isLaunchSplashCovering);
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return <NoLaunchSting />;
  // Unmounted once it has gone, which releases its player: a hardware decoder
  // held for the session would be one the feed's previews cannot have.
  return covering ? <LaunchSting shellReady={shellReady} /> : null;
}

/** Elsewhere there is no native splash to continue: let go at once. */
function NoLaunchSting() {
  const pathname = usePathname();
  useEffect(() => {
    hideNativeSplash();
    releaseNativeAppearance();
    reportStartupMilestone({ milestone: 'launch-splash-lifted', pathname });
    endLaunchSplash();
  }, [pathname]);
  return null;
}

/**
 * The overlay's say over the status bar and Android's navigation bar, in its
 * own scheme rather than the app's. Each goes to the claim mounted last, so
 * this mounts a commit after the root's, and again for every route the app
 * moves to beneath it (it is keyed on the path), after that screen's claims.
 */
function LaunchSystemBars({ scheme }: { scheme: ColorScheme }) {
  useNavigationBarSurface(scheme);
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}

function LaunchSting({ shellReady }: { shellReady: boolean }) {
  const [scheme] = useState(readPhoneScheme);
  const [opacity] = useState(() => new Animated.Value(1, { useNativeDriver: true }));
  const motion = useLaunchMotion();
  const pathname = usePathname();
  const iconSize = launchSplashIconSize(Platform.OS, useWindowDimensions());
  const routeSettled = useSyncExternalStore(subscribeLaunchSplash, isLaunchRouteSettled, isLaunchRouteSettled);
  const [stillDrawn, setStillDrawn] = useState(false);
  const [clip, setClip] = useState<LaunchClip>('waiting');
  const [timedOut, setTimedOut] = useState(false);
  const [barsClaimed, setBarsClaimed] = useState(false);
  const reveal = shouldRevealApp({ clip, routeSettled, shellReady, timedOut });

  // Under Reduce Motion the clip's player is let go as soon as that is known.
  const source = motion === 'reduced' ? null : scheme === 'dark' ? stingDark : stingLight;
  const player = useVideoPlayer(source, (instance) => {
    instance.loop = false;
    instance.muted = true;
    instance.volume = 0;
    instance.showNowPlayingNotification = false;
    instance.staysActiveInBackground = false;
    // Silent by construction, so it stays out of the audio session and music
    // already playing carries on (as the feed's previews do).
    instance.audioMixingMode = 'auto';
  });

  useEffect(() => {
    setBarsClaimed(true);
  }, []);

  // The native splash comes down once the still has taken its place, pixel for
  // pixel. A still that never reports itself drawn must not hold it up.
  useEffect(() => {
    if (stillDrawn) {
      hideNativeSplash();
      return;
    }
    const fallback = setTimeout(() => setStillDrawn(true), LAUNCH_STILL_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [stillDrawn]);

  // Then the clip plays over the still, which is its own first frame, unless
  // the overlay is already leaving: timers held back in the background fire
  // together on return, so the cap can land before the clip has started.
  useEffect(() => {
    if (reveal || !stillDrawn || clip !== 'waiting' || motion === 'unknown') return;
    if (motion === 'reduced') {
      setClip('skipped');
      return;
    }
    player.play();
    setClip('playing');
  }, [clip, motion, player, reveal, stillDrawn]);

  // A clip that has not finished well after its length gives way to the still
  // it ends on (LAUNCH_CLIP_DEADLINE_MS says when that happens).
  useEffect(() => {
    if (clip !== 'playing') return;
    const deadline = setTimeout(() => {
      player.pause();
      setClip('skipped');
    }, LAUNCH_CLIP_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [clip, player]);

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

  const fadeMs = motion === 'reduced' ? 0 : FADE_OUT_MS;
  useEffect(() => {
    if (!reveal) return;
    // The native splash went long since, so a stored Appearance choice may
    // reach the native layer now (lib/appearance.ts).
    releaseNativeAppearance();
    Animated.timing(opacity, {
      toValue: 0,
      duration: fadeMs,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      reportStartupMilestone({ milestone: 'launch-splash-lifted', pathname });
      endLaunchSplash();
    });
    // `pathname` only labels the milestone; the fade must not restart for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fadeMs, opacity, reveal]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents={reveal ? 'none' : 'auto'}
      style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: launchSplashGround(scheme), opacity }]}
    >
      {barsClaimed ? <LaunchSystemBars key={pathname} scheme={scheme} /> : null}
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
        {/* Only while the clip runs and the overlay stays: its ends are the
            still beneath it, and on Android a video surface does not fade
            with its parent — left in, it flashed black over the app. */}
        {(clip === 'waiting' || clip === 'playing') && !reveal ? (
          <VideoView
            {...FEED_VIDEO_VIEW_PROPS}
            player={player}
            contentFit="contain"
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
