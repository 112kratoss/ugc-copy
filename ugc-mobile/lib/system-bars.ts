import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import type { ColorScheme } from '@/lib/theme';

/**
 * Android's navigation bar icons (the three-button bar; the gesture handle
 * adapts on its own). React Native sets their colour once, when the activity
 * is created, from the night mode at that moment — `enableEdgeToEdge()` in
 * `WindowUtil.kt`. Anything after that leaves them wrong until the next cold
 * start: the phone switching schemes, a choice under Settings → Appearance,
 * or the reel, which stays dark over a light app.
 *
 * Read through `requireOptionalNativeModule` rather than the package's own
 * wrapper, which requires the module at import and would crash a build that
 * predates it. There the bar simply keeps its launch colour.
 */
type NavigationBarModule = {
  setButtonStyleAsync(style: 'light' | 'dark'): Promise<void>;
};

let navigationBar: NavigationBarModule | null | undefined;

/**
 * Resolved on first use, and only on Android: `expo` is required lazily so
 * that a screen importing this hook costs nothing at load time and pulls
 * nothing native into the iOS path or into focused tests.
 */
function readNavigationBarModule() {
  if (navigationBar !== undefined) return navigationBar;
  navigationBar = null;
  try {
    if (Platform.OS !== 'android') return navigationBar;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requireOptionalNativeModule } = require('expo') as typeof import('expo');
    navigationBar = requireOptionalNativeModule<NavigationBarModule>('ExpoNavigationBar');
  } catch {
    navigationBar = null;
  }
  return navigationBar;
}

/** Light icons on a dark surface, dark icons on a light one. */
export function navigationBarButtonStyle(surface: ColorScheme): 'light' | 'dark' {
  return surface === 'dark' ? 'light' : 'dark';
}

type SurfaceEntry = { surface: ColorScheme | null };

/**
 * Every mounted surface that wants a say, in mount order. The last one with a
 * scheme wins — the root declares the app's, a reel or a lightbox above it
 * declares dark while it is in front. An entry keeps its place when its scheme
 * changes, so a phone switching schemes under an open reel updates the root's
 * entry without lifting it above the reel's.
 */
const surfaces: SurfaceEntry[] = [];
let applied: ColorScheme | null = null;

function applyTopSurface(setButtonStyle: (style: 'light' | 'dark') => void) {
  for (let index = surfaces.length - 1; index >= 0; index -= 1) {
    const { surface } = surfaces[index];
    if (!surface) continue;
    if (surface !== applied) {
      applied = surface;
      setButtonStyle(navigationBarButtonStyle(surface));
    }
    return;
  }
}

function setNativeButtonStyle(style: 'light' | 'dark') {
  void readNavigationBarModule()?.setButtonStyleAsync(style).catch(() => undefined);
}

/**
 * Declares the surface under Android's navigation bar while the calling
 * component is mounted: its scheme, or `null` to have no say (a reel that is
 * no longer in front). A no-op on iOS, whose home indicator adapts itself.
 */
export function useNavigationBarSurface(
  surface: ColorScheme | null,
  setButtonStyle: (style: 'light' | 'dark') => void = setNativeButtonStyle,
) {
  const entry = useRef<SurfaceEntry | null>(null);

  useEffect(() => {
    const mine: SurfaceEntry = { surface: null };
    entry.current = mine;
    surfaces.push(mine);
    return () => {
      const at = surfaces.indexOf(mine);
      if (at >= 0) surfaces.splice(at, 1);
      entry.current = null;
      applyTopSurface(setButtonStyle);
    };
  }, [setButtonStyle]);

  useEffect(() => {
    if (!entry.current) return;
    entry.current.surface = surface;
    applyTopSurface(setButtonStyle);
  }, [setButtonStyle, surface]);
}

/** Test seam: the stack is process state. */
export function resetNavigationBarSurfacesForTests() {
  surfaces.length = 0;
  applied = null;
}
