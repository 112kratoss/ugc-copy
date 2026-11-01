import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const player = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    setUp: false,
    loop: true,
    muted: false,
    volume: 1,
    showNowPlayingNotification: true,
    staysActiveInBackground: true,
    audioMixingMode: 'doNotMix' as string,
    play: vi.fn(),
    pause: vi.fn(),
    addListener: vi.fn((event: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return { remove: () => listeners.get(event)?.delete(listener) };
    }),
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
});
const clip = vi.hoisted(() => ({ sources: [] as unknown[] }));
const splash = vi.hoisted(() => ({ hideAsync: vi.fn(async () => undefined) }));
const motion = vi.hoisted(() => ({ reduced: false }));
const appearance = vi.hoisted(() => ({ scheme: 'light' as 'light' | 'dark', release: vi.fn() }));
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));
const animation = vi.hoisted(() => ({ timing: vi.fn() }));

vi.mock('expo-video', () => ({
  useVideoPlayer: (source: unknown, setup?: (instance: typeof player) => void) => {
    clip.sources.push(source);
    if (!player.setUp) {
      player.setUp = true;
      setup?.(player);
    }
    return player;
  },
  VideoView: (props: Record<string, unknown>) => React.createElement('video-view', props),
}));
vi.mock('expo-splash-screen', () => ({ hideAsync: splash.hideAsync }));
vi.mock('expo-status-bar', () => ({ StatusBar: (props: Record<string, unknown>) => React.createElement('status-bar', props) }));
vi.mock('@/lib/motion', () => ({ useReducedMotion: () => motion.reduced }));
vi.mock('@/lib/appearance', () => ({ releaseNativeAppearance: appearance.release }));
vi.mock('react-native', () => {
  class Value {
    constructor(public value: number) {}
  }
  return {
    Platform: platform,
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
    },
    useWindowDimensions: () => ({ width: 402, height: 874 }),
    useColorScheme: () => appearance.scheme,
    Easing: { out: (easing: unknown) => easing, quad: (t: number) => t },
    Animated: {
      Value,
      View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('animated-view', props, children),
      timing: (value: unknown, config: Record<string, unknown>) => {
        animation.timing(value, config);
        return { start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }) };
      },
    },
    View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement('view', props, children),
  };
});

import { LaunchSplash } from '../components/launch-splash';
import {
  ANDROID_SPLASH_ICON_DP,
  endLaunchSplash,
  isLaunchRouteSettled,
  isLaunchSplashCovering,
  LAUNCH_CLIP_START_TIMEOUT_MS,
  LAUNCH_SPLASH_MAX_MS,
  LAUNCH_STILL_FALLBACK_MS,
  launchSplashGround,
  launchSplashIconSize,
  markLaunchRouteSettled,
  resetLaunchSplashForTests,
  shouldRevealApp,
  subscribeLaunchSplash,
} from '../lib/launch-splash';
import { themes } from '../lib/theme';

const mobileRoot = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(mobileRoot, file), 'utf8');
const appJson = JSON.parse(read('app.json')).expo;

describe('launch splash rules', () => {
  beforeEach(() => resetLaunchSplashForTests());

  it('draws on the ground each native splash is drawn on', () => {
    for (const os of ['ios', 'android'] as const) {
      expect(launchSplashGround('light')).toBe(appJson[os].splash.backgroundColor);
      expect(launchSplashGround('dark')).toBe(appJson[os].splash.dark.backgroundColor);
    }
  });

  it('puts the clip in the square each platform draws the splash image in', () => {
    // iOS lays the image out `contain` over the whole screen.
    expect(launchSplashIconSize('ios', { width: 402, height: 874 })).toBe(402);
    expect(launchSplashIconSize('ios', { width: 375, height: 667 })).toBe(375);
    // Android draws it at expo-splash-screen's default image width, which holds
    // only while app.json names none.
    expect(launchSplashIconSize('android', { width: 411, height: 923 })).toBe(ANDROID_SPLASH_ICON_DP);
    expect(JSON.stringify(appJson)).not.toContain('imageWidth');
  });

  it('ships a light and a dark clip, each small enough to add little to an update', () => {
    for (const name of ['splash-sting-light.mp4', 'splash-sting-dark.mp4']) {
      const file = path.join(mobileRoot, 'assets/video', name);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).size).toBeLessThan(400 * 1024);
    }
  });

  it('lets the app through only once the sting is over, the first screen decided and the shell ready', () => {
    const ready = { routeSettled: true, shellReady: true, timedOut: false };
    expect(shouldRevealApp({ ...ready, clip: 'waiting' })).toBe(false);
    expect(shouldRevealApp({ ...ready, clip: 'playing' })).toBe(false);
    expect(shouldRevealApp({ ...ready, clip: 'ended' })).toBe(true);
    expect(shouldRevealApp({ ...ready, clip: 'skipped' })).toBe(true);
    expect(shouldRevealApp({ ...ready, clip: 'ended', routeSettled: false })).toBe(false);
    expect(shouldRevealApp({ ...ready, clip: 'ended', shellReady: false })).toBe(false);
    expect(shouldRevealApp({ clip: 'playing', routeSettled: false, shellReady: false, timedOut: true })).toBe(true);
  });

  it('tells subscribers once when the first screen is decided, and once when the overlay has gone', () => {
    const listener = vi.fn();
    subscribeLaunchSplash(listener);
    expect(isLaunchRouteSettled()).toBe(false);
    markLaunchRouteSettled();
    markLaunchRouteSettled();
    expect(isLaunchRouteSettled()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(isLaunchSplashCovering()).toBe(true);
    endLaunchSplash();
    endLaunchSplash();
    expect(isLaunchSplashCovering()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('root layout and the launch splash', () => {
  const layout = read('app/_layout.tsx');

  it('leaves hiding the native splash to the overlay, drawn above everything', () => {
    expect(layout).toContain('SplashScreen.preventAutoHideAsync()');
    expect(layout).not.toContain('SplashScreen.hideAsync');
    expect(layout).toContain('<LaunchSplash shellReady={shellReady} />');
    expect(layout.indexOf('<LaunchSplash shellReady={shellReady} />')).toBeGreaterThan(layout.indexOf('<ZoomPostPreparer />'));
  });

  it('sends a fresh install to onboarding without a fade while the overlay covers the app', () => {
    expect(layout).toContain("animation: reducedMotion ? 'none' : isLaunchSplashCovering() ? 'none' : 'fade'");
    const redirect = layout.indexOf("router.replace('/onboarding' as never)");
    expect(redirect).toBeGreaterThan(0);
    expect(layout.indexOf('markLaunchRouteSettled()', redirect)).toBeGreaterThan(redirect);
  });
});

describe('LaunchSplash', () => {
  let tree: renderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    resetLaunchSplashForTests();
    player.listeners.clear();
    player.setUp = false;
    player.loop = true;
    player.muted = false;
    player.volume = 1;
    player.audioMixingMode = 'doNotMix';
    player.play.mockClear();
    player.pause.mockClear();
    clip.sources = [];
    splash.hideAsync.mockClear();
    animation.timing.mockClear();
    motion.reduced = false;
    appearance.scheme = 'light';
    appearance.release.mockClear();
    platform.OS = 'ios';
  });

  afterEach(() => {
    renderer.act(() => tree?.unmount());
    tree = undefined;
    vi.useRealTimers();
  });

  function mount(shellReady = false) {
    renderer.act(() => {
      tree = renderer.create(<LaunchSplash shellReady={shellReady} />);
    });
    return tree!;
  }

  const still = () => tree!.root.findByType('image' as never);
  const video = () => tree!.root.findByType('video-view' as never);

  it('keeps the native splash up until the still is drawn, then plays the silent clip over it', () => {
    mount();
    expect(splash.hideAsync).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    expect(player).toMatchObject({ loop: false, muted: true, volume: 0, audioMixingMode: 'auto' });

    renderer.act(() => still().props.onDisplay());
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(video().props).toMatchObject({ nativeControls: false, contentFit: 'contain', useExoShutter: false });
  });

  it('lets a stored Appearance choice reach the native layer only once the native splash is down', async () => {
    let hidden!: () => void;
    splash.hideAsync.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      hidden = () => resolve(undefined);
    }));
    mount();
    renderer.act(() => still().props.onDisplay());
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(appearance.release).not.toHaveBeenCalled();

    await renderer.act(async () => {
      hidden();
    });
    expect(appearance.release).toHaveBeenCalled();
  });

  it('covers the app until the clip has ended, the first screen is decided and the shell is ready', () => {
    mount();
    renderer.act(() => still().props.onDisplay());
    renderer.act(() => player.emit('playToEnd'));
    // The still it ended on stays; the video goes, so no video surface is left
    // to flash black while the overlay fades on Android.
    expect(tree!.root.findAllByType('video-view' as never)).toHaveLength(0);
    expect(still()).toBeTruthy();
    renderer.act(() => markLaunchRouteSettled());
    expect(animation.timing).not.toHaveBeenCalled();
    expect(isLaunchSplashCovering()).toBe(true);

    renderer.act(() => tree!.update(<LaunchSplash shellReady />));
    expect(animation.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 0, useNativeDriver: true }));
    expect(tree!.toJSON()).toBeNull();
    expect(isLaunchSplashCovering()).toBe(false);
  });

  it('plays nothing under Reduce Motion, and still holds the app until it is ready', () => {
    motion.reduced = true;
    mount();
    renderer.act(() => still().props.onDisplay());
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    expect(tree!.toJSON()).not.toBeNull();

    renderer.act(() => markLaunchRouteSettled());
    renderer.act(() => tree!.update(<LaunchSplash shellReady />));
    expect(tree!.toJSON()).toBeNull();
  });

  it('lets the still stand in for a clip that never draws its first frame', () => {
    vi.useFakeTimers();
    mount(true);
    renderer.act(() => still().props.onDisplay());
    renderer.act(() => markLaunchRouteSettled());
    renderer.act(() => {
      vi.advanceTimersByTime(LAUNCH_CLIP_START_TIMEOUT_MS);
    });
    expect(player.pause).toHaveBeenCalled();
    expect(tree!.toJSON()).toBeNull();
  });

  it('lets a clip that has drawn play on past the start deadline', () => {
    vi.useFakeTimers();
    mount(true);
    renderer.act(() => still().props.onDisplay());
    renderer.act(() => video().props.onFirstFrameRender());
    renderer.act(() => markLaunchRouteSettled());
    renderer.act(() => {
      vi.advanceTimersByTime(LAUNCH_CLIP_START_TIMEOUT_MS);
    });
    expect(player.pause).not.toHaveBeenCalled();
    expect(tree!.toJSON()).not.toBeNull();
  });

  it('brings the native splash down even if the still never reports itself drawn', () => {
    vi.useFakeTimers();
    mount();
    renderer.act(() => {
      vi.advanceTimersByTime(LAUNCH_STILL_FALLBACK_MS);
    });
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('never outstays its cap, whatever is still loading', () => {
    vi.useFakeTimers();
    mount();
    renderer.act(() => {
      vi.advanceTimersByTime(LAUNCH_SPLASH_MAX_MS);
    });
    expect(tree!.toJSON()).toBeNull();
    expect(isLaunchSplashCovering()).toBe(false);
  });

  const ground = () =>
    (tree!.root.findByType('animated-view' as never).props.style as Array<Record<string, unknown>>)
      .find((style) => style && 'backgroundColor' in style)?.backgroundColor;

  it('continues the scheme the native splash is drawn in, with that scheme’s clip', () => {
    appearance.scheme = 'dark';
    mount();
    expect(ground()).toBe(themes.dark.colors.app);
    expect(String(clip.sources.at(-1))).toMatch(/splash-sting-dark\.mp4/);
  });

  it('follows the native splash into a restored Appearance choice until it takes over, then holds', () => {
    mount();
    expect(ground()).toBe(themes.light.colors.background);

    // The stored choice is applied natively before the handover: the native
    // splash redraws dark, and so does the overlay beneath it.
    appearance.scheme = 'dark';
    renderer.act(() => tree!.update(<LaunchSplash shellReady={false} />));
    expect(ground()).toBe(themes.dark.colors.app);
    expect(String(clip.sources.at(-1))).toMatch(/splash-sting-dark\.mp4/);

    // After the handover a change belongs to the app beneath.
    renderer.act(() => still().props.onDisplay());
    appearance.scheme = 'light';
    renderer.act(() => tree!.update(<LaunchSplash shellReady={false} />));
    expect(ground()).toBe(themes.dark.colors.app);
  });

  it('lets go at once where there is no native splash to continue', () => {
    platform.OS = 'web';
    mount();
    expect(tree!.toJSON()).toBeNull();
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(isLaunchSplashCovering()).toBe(false);
  });
});
