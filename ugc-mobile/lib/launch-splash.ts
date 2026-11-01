import { themes, type ColorScheme } from './theme';

/**
 * The launch sting: a 1.5 s clip that takes over from the native splash the
 * moment JavaScript runs (components/launch-splash.tsx). A launch screen cannot
 * play video — iOS draws a static storyboard and Android 12 allows only a short
 * animated icon — so the clip is an overlay on the same ground, in the same
 * square, starting on the same picture: its first frame and its last half
 * second are splash-icon.png exactly, and the hand-over cannot be seen. The
 * clips come from scripts/make-splash-sting.mjs; run it again whenever the
 * splash image or a splash colour changes.
 *
 * The overlay also covers the app until its first screen is decided. That used
 * to happen in the open: a fresh install drew Home for about 0.65 s before
 * onboarding faded in over it.
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

/** waiting: the still is up, nothing played yet. skipped: Reduce Motion, no clip, or the clip failed to start. */
export type LaunchClip = 'waiting' | 'playing' | 'ended' | 'skipped';

/** The native splash comes down this long after mount even if the still never reports itself drawn. */
export const LAUNCH_STILL_FALLBACK_MS = 1_000;
/** How long the clip may take to draw its first frame before the still stands in for it. */
export const LAUNCH_CLIP_START_TIMEOUT_MS = 1_200;
/** The overlay never outstays this, whatever is still loading underneath it. */
export const LAUNCH_SPLASH_MAX_MS = 6_000;

export type LaunchRevealInput = {
  clip: LaunchClip;
  /** StartupCoordinator has decided the first screen (and replaced to it if it had to). */
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

/** Called by StartupCoordinator once the first screen is decided. */
export function markLaunchRouteSettled() {
  if (routeSettled) return;
  routeSettled = true;
  emit();
}

/**
 * Whether the launch overlay is still over the app. The onboarding route reads
 * it when a fresh install is sent there: under the overlay its fade would only
 * hold Home on screen beneath it, so it arrives without one.
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
