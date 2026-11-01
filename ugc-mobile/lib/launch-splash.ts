import { themes, type ColorScheme } from './theme';

/**
 * The launch sting: a clip of a little over a second that takes over from the
 * native splash the moment JavaScript runs (components/launch-splash.tsx). A
 * launch screen cannot play video — iOS draws a static storyboard and Android
 * 12 allows only a short animated icon — so the clip is an overlay on the same
 * ground, in the same square, starting on the same picture: its first frame and
 * its last are splash-icon.png exactly, and the hand-over cannot be seen. The
 * clips come from scripts/make-splash-sting.mjs; run it again whenever the
 * splash image or a splash colour changes.
 *
 * Pure on purpose, like the view-model modules: no React Native here, so the
 * rules are tested without rendering.
 */

/** The ground each scheme's native splash is drawn on (app.json; appearance-native-config.test.ts). */
export function launchSplashGround(scheme: ColorScheme): string {
  return scheme === 'light' ? themes.light.colors.background : themes.dark.colors.app;
}

/**
 * The side of the square, centred on the screen, in which the native splash
 * draws splash-icon.png's canvas — so the clip lands on the same pixels. iOS
 * lays the image out `contain` over the whole screen: as wide as the screen
 * (an iPhone 17 Pro measured 402 × 402 pt at y 236). Android 12's splash draws
 * it at expo-splash-screen's default image width, 200 dp (a Pixel 9a measured
 * 525 px at 420 dpi, centred at 540, 1212 of 1080 × 2424).
 */
export const ANDROID_SPLASH_ICON_DP = 200;

export function launchSplashIconSize(platform: string, screen: { width: number; height: number }): number {
  return platform === 'android' ? ANDROID_SPLASH_ICON_DP : Math.min(screen.width, screen.height);
}

/** waiting: the still is up, nothing played yet. skipped: Reduce Motion, or a clip that failed or gave out. */
export type LaunchClip = 'waiting' | 'playing' | 'ended' | 'skipped';

/** The native splash comes down this long after mount even if the still never reports itself drawn. */
export const LAUNCH_STILL_FALLBACK_MS = 1_000;
/**
 * A clip still playing this long after it was asked to gives way to the still
 * it ends on: it never started, it stalled, or the app was put away mid-clip
 * (expo-video pauses a player in the background and never resumes it).
 */
export const LAUNCH_CLIP_DEADLINE_MS = 2_500;
/** The overlay never outstays this, whatever is still loading underneath it. */
export const LAUNCH_SPLASH_MAX_MS = 6_000;

export type LaunchRevealInput = {
  clip: LaunchClip;
  /** StartupCoordinator's first screen is on screen: nothing had to move, or its redirect has landed. */
  routeSettled: boolean;
  /** Fonts and the stored appearance are in, as the native splash used to wait for. */
  shellReady: boolean;
  timedOut: boolean;
};

/** Whether the overlay may leave: the sting has finished and the app underneath is the screen it will stay on. */
export function shouldRevealApp({ clip, routeSettled, shellReady, timedOut }: LaunchRevealInput): boolean {
  if (timedOut) return true;
  return (clip === 'ended' || clip === 'skipped') && routeSettled && shellReady;
}

// ---------- process state: one launch per JavaScript runtime ----------

let routeSettled = false;
let covering = true;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeLaunchSplash(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isLaunchRouteSettled() {
  return routeSettled;
}

/** Called by StartupCoordinator once the first screen is on screen. */
export function markLaunchRouteSettled() {
  if (routeSettled) return;
  routeSettled = true;
  emit();
}

/**
 * Whether the launch splash is still over the app. Once it has gone it stays
 * gone for the runtime: a root remounted after an error, or an activity made
 * again in a live process, does not play it a second time.
 */
export function isLaunchSplashCovering() {
  return covering;
}

/** Called by the overlay once it has gone (or on platforms that never draw it). */
export function endLaunchSplash() {
  if (!covering) return;
  covering = false;
  emit();
}

/** Test seam: the module holds process state. */
export function resetLaunchSplashForTests() {
  routeSettled = false;
  covering = true;
  listeners.clear();
}
