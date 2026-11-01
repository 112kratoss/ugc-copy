import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const player = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
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
const clip = vi.hoisted(() => ({ sources: [] as unknown[], setups: 0 }));
const splash = vi.hoisted(() => ({ hideAsync: vi.fn(async () => undefined), setOptions: vi.fn() }));
const motion = vi.hoisted(() => ({ reduced: false, answer: 'now' as 'now' | 'never' }));
const phone = vi.hoisted(() => ({ scheme: 'light' as 'light' | 'dark' }));
const platform = vi.hoisted(() => ({ OS: 'ios' as string }));
const route = vi.hoisted(() => ({ pathname: '/' }));
const animation = vi.hoisted(() => ({ timing: vi.fn(), onTiming: undefined as undefined | (() => void) }));
const bars = vi.hoisted(() => ({ surfaces: [] as unknown[], statusBarMounts: 0 }));
const appearance = vi.hoisted(() => ({ release: vi.fn() }));
const milestones = vi.hoisted(() => ({ report: vi.fn() }));

vi.mock('expo-video', () => ({
  useVideoPlayer: (source: unknown, setup?: (instance: typeof player) => void) => {
    if (clip.sources.at(-1) !== source || clip.sources.length === 0) {
      clip.setups += 1;
      setup?.(player);
    }
    clip.sources.push(source);
    return player;
  },
  VideoView: (props: Record<string, unknown>) => React.createElement('video-view', props),
}));
vi.mock('expo-splash-screen', () => ({ hideAsync: splash.hideAsync, setOptions: splash.setOptions }));
vi.mock('expo-status-bar', () => ({
  StatusBar: (props: Record<string, unknown>) => {
    React.useEffect(() => {
      bars.statusBarMounts += 1;
    }, []);
    return React.createElement('status-bar', props);
  },
}));
vi.mock('expo-router', () => ({ usePathname: () => route.pathname }));
vi.mock('@/lib/system-bars', () => ({ useNavigationBarSurface: (surface: unknown) => bars.surfaces.push(surface) }));
vi.mock('@/lib/appearance', () => ({ releaseNativeAppearance: appearance.release }));
vi.mock('@/lib/startup-interactive', () => ({ reportStartupMilestone: milestones.report }));
vi.mock('@/lib/motion', () => ({ useReducedMotionAnswer: () => (motion.answer === 'never' ? null : motion.reduced) }));
vi.mock('react-native', () => {
  class Value {
    constructor(public value: number, public config?: unknown) {}
  }
  return {
    Platform: platform,
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
    },
    useWindowDimensions: () => ({ width: 402, height: 874 }),
    Appearance: { getColorScheme: () => phone.scheme },
    Easing: { out: (easing: unknown) => easing, quad: (t: number) => t },
    Animated: {
      Value,
      View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('animated-view', props, children),
      timing: (value: unknown, config: Record<string, unknown>) => {
        animation.timing(value, config);
        animation.onTiming?.();
        return { start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }) };
      },
    },
    View: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement('view', props, children),
  };
});

import { LaunchSplash } from '../components/launch-splash';
import { FEED_VIDEO_VIEW_PROPS } from '../lib/feed-video-view-props';
import {
  ANDROID_SPLASH_ICON_DP,
  endLaunchSplash,
  isLaunchRouteSettled,
  isLaunchSplashCovering,
  LAUNCH_CLIP_DEADLINE_MS,
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

  it('lets the app through only once the sting is over, the first screen is on screen and the shell is ready', () => {
    const ready = { routeSettled: true, shellReady: true, timedOut: false };
    expect(shouldRevealApp({ ...ready, clip: 'waiting' })).toBe(false);
    expect(shouldRevealApp({ ...ready, clip: 'playing' })).toBe(false);
    expect(shouldRevealApp({ ...ready, clip: 'ended' })).toBe(true);
    expect(shouldRevealApp({ ...ready, clip: 'skipped' })).toBe(true);
    expect(shouldRevealApp({ ...ready, clip: 'ended', routeSettled: false })).toBe(false);
    expect(shouldRevealApp({ ...ready, clip: 'ended', shellReady: false })).toBe(false);
    expect(shouldRevealApp({ clip: 'playing', routeSettled: false, shellReady: false, timedOut: true })).toBe(true);
  });

  it('tells subscribers once when the first screen is on screen, and once when the overlay has gone', () => {
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

  it('draws the overlay beside the app rather than inside it, so above the startup cover too', () => {
    const overlay = layout.indexOf('<LaunchSplash shellReady={shellReady} />');
    expect(overlay).toBeGreaterThan(layout.indexOf('</SafeAreaProvider>'));
    expect(overlay).toBeLessThan(layout.indexOf('</OnboardingProvider>'));
    expect(layout.match(/<LaunchSplash /g)).toHaveLength(1);
  });

  it('leaves hiding the native splash to the overlay, and makes it a cut on Android too', () => {
    expect(layout).toContain('SplashScreen.preventAutoHideAsync()');
    expect(layout).toContain('SplashScreen.setOptions({ duration: 0, fade: false })');
    expect(layout).not.toContain('SplashScreen.hideAsync');
  });

  it('covers home until the launch redirect to onboarding has landed, and settles only then', () => {
    expect(layout).toContain("router.replace({ pathname: '/onboarding', params: { entry: ONBOARDING_LAUNCH_ENTRY } } as never)");
    expect(layout).toContain("if (pathname === '/' && (!isHydrated || isLoading || holdingForRedirect))");
    const effect = layout.slice(layout.indexOf('if (holdingForRedirect) {'));
    expect(effect.indexOf('return () => clearTimeout(fallback);')).toBeLessThan(effect.indexOf('markLaunchRouteSettled();'));
    expect(layout).toContain("animation: reducedMotion ? 'none' : onboardingAnimation(route.params)");
  });
});

describe('LaunchSplash', () => {
  let tree: renderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    resetLaunchSplashForTests();
    player.listeners.clear();
    player.loop = true;
    player.muted = false;
    player.volume = 1;
    player.audioMixingMode = 'doNotMix';
    player.play.mockClear();
    player.pause.mockClear();
    clip.sources = [];
    clip.setups = 0;
    splash.hideAsync.mockClear();
    animation.timing.mockClear();
    animation.onTiming = undefined;
    motion.reduced = false;
    motion.answer = 'now';
    phone.scheme = 'light';
    platform.OS = 'ios';
    route.pathname = '/';
    bars.surfaces = [];
    bars.statusBarMounts = 0;
    appearance.release.mockClear();
    milestones.report.mockClear();
  });

  afterEach(() => {
    renderer.act(() => tree?.unmount());
    tree = undefined;
    vi.useRealTimers();
  });

  /** Mounts and lets the Reduce Motion answer arrive. */
  async function mount(shellReady = false) {
    await renderer.act(async () => {
      tree = renderer.create(<LaunchSplash shellReady={shellReady} />);
    });
    return tree!;
  }

  const still = () => tree!.root.findByType('image' as never);
  const videos = () => tree!.root.findAllByType('video-view' as never);
  const ground = () =>
    (tree!.root.findByType('animated-view' as never).props.style as Array<Record<string, unknown>>)
      .find((style) => style && 'backgroundColor' in style)?.backgroundColor;

  it('keeps the native splash up until the still is drawn, then plays the silent clip over it', async () => {
    await mount();
    expect(splash.hideAsync).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    expect(player).toMatchObject({ loop: false, muted: true, volume: 0, audioMixingMode: 'auto' });

    renderer.act(() => still().props.onDisplay());
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(videos()[0].props).toMatchObject({ ...FEED_VIDEO_VIEW_PROPS, contentFit: 'contain' });
  });

  it('plays nothing until it knows whether motion is reduced', async () => {
    motion.answer = 'never';
    vi.useFakeTimers();
    renderer.act(() => {
      tree = renderer.create(<LaunchSplash shellReady={false} />);
    });
    renderer.act(() => still().props.onDisplay());
    expect(player.play).not.toHaveBeenCalled();
  });

  it('plays nothing under Reduce Motion, lets the clip go, and still holds the app until it is ready', async () => {
    motion.reduced = true;
    await mount();
    expect(clip.sources.at(-1)).toBeNull();
    renderer.act(() => still().props.onDisplay());
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
    expect(videos()).toHaveLength(0);
    expect(tree!.toJSON()).not.toBeNull();

    renderer.act(() => markLaunchRouteSettled());
    renderer.act(() => tree!.update(<LaunchSplash shellReady />));
    expect(animation.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: 0 }));
    expect(tree!.toJSON()).toBeNull();
  });

  it('leaves once the clip has ended, the first screen is on screen and the shell is ready, and only then', async () => {
    await mount();
    renderer.act(() => still().props.onDisplay());
    renderer.act(() => player.emit('playToEnd'));
    // The still it ended on stays; the video goes.
    expect(videos()).toHaveLength(0);
    renderer.act(() => markLaunchRouteSettled());
    expect(animation.timing).not.toHaveBeenCalled();
    expect(appearance.release).not.toHaveBeenCalled();
    expect(isLaunchSplashCovering()).toBe(true);

    renderer.act(() => tree!.update(<LaunchSplash shellReady />));
    expect(animation.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 0, useNativeDriver: true }));
    expect(tree!.root.findAllByType('animated-view' as never)).toHaveLength(0);
    expect(isLaunchSplashCovering()).toBe(false);
    expect(milestones.report).toHaveBeenCalledWith(expect.objectContaining({ milestone: 'launch-splash-lifted' }));
  });

  it('lets a stored Appearance choice reach the native layer as it leaves, not when the native splash is asked to go', async () => {
    await mount();
    renderer.act(() => still().props.onDisplay());
    await renderer.act(async () => {});
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(appearance.release).not.toHaveBeenCalled();

    renderer.act(() => player.emit('playToEnd'));
    renderer.act(() => markLaunchRouteSettled());
    renderer.act(() => tree!.update(<LaunchSplash shellReady />));
    expect(appearance.release).toHaveBeenCalledTimes(1);
  });

  it('gives way to the still when the clip outlives its deadline: stalled, or paused by a trip to the background', async () => {
    vi.useFakeTimers();
    await mount(true);
    renderer.act(() => still().props.onDisplay());
    renderer.act(() => markLaunchRouteSettled());
    renderer.act(() => {
      vi.advanceTimersByTime(LAUNCH_CLIP_DEADLINE_MS);
    });
    expect(player.pause).toHaveBeenCalled();
    expect(tree!.toJSON()).toBeNull();
  });

  it('takes the video out before it fades, even when the cap ends it before the clip has finished', async () => {
    // Timers held back by a trip to the background fire together on return:
    // the still and motion fallbacks land in the same render as the cap, with
    // the clip still waiting to start (the deadline only runs once it plays).
    motion.answer = 'never';
    vi.useFakeTimers();
    renderer.act(() => {
      tree = renderer.create(<LaunchSplash shellReady={false} />);
    });
    let videosAtFade = -1;
    animation.onTiming = () => {
      videosAtFade = videos().length;
    };
    renderer.act(() => {
      vi.advanceTimersByTime(LAUNCH_SPLASH_MAX_MS);
    });
    expect(videosAtFade).toBe(0);
    expect(player.play).not.toHaveBeenCalled();
    expect(isLaunchSplashCovering()).toBe(false);
  });

  it('brings the native splash down even if the still never reports itself drawn', async () => {
    vi.useFakeTimers();
    await mount();
    renderer.act(() => {
      vi.advanceTimersByTime(LAUNCH_STILL_FALLBACK_MS);
    });
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('plays once per runtime: gone, it draws nothing and makes no player when the root mounts again', async () => {
    await mount(true);
    renderer.act(() => still().props.onDisplay());
    renderer.act(() => player.emit('playToEnd'));
    renderer.act(() => markLaunchRouteSettled());
    expect(tree!.toJSON()).toBeNull();

    renderer.act(() => tree!.unmount());
    const setupsBefore = clip.setups;
    await mount(true);
    expect(tree!.toJSON()).toBeNull();
    expect(clip.setups).toBe(setupsBefore);
  });

  it('continues the scheme the phone shows, with that scheme’s clip', async () => {
    phone.scheme = 'dark';
    await mount();
    expect(ground()).toBe(themes.dark.colors.app);
    expect(String(clip.sources.at(-1))).toMatch(/splash-sting-dark\.mp4/);
  });

  it('holds the status bar and Android’s navigation bar in its own scheme, over each screen mounted beneath it', async () => {
    await mount();
    expect(tree!.root.findByType('status-bar' as never).props.style).toBe('dark');
    expect(bars.surfaces.at(-1)).toBe('light');
    const mounts = bars.statusBarMounts;

    // The redirect mounts onboarding, with bars of its own, beneath the overlay.
    route.pathname = '/onboarding';
    renderer.act(() => tree!.update(<LaunchSplash shellReady={false} />));
    expect(bars.statusBarMounts).toBe(mounts + 1);
  });

  it('lets go at once where there is no native splash to continue', async () => {
    platform.OS = 'web';
    await mount();
    expect(tree!.toJSON()).toBeNull();
    expect(splash.hideAsync).toHaveBeenCalled();
    expect(appearance.release).toHaveBeenCalled();
    expect(milestones.report).toHaveBeenCalledWith(expect.objectContaining({ milestone: 'launch-splash-lifted' }));
    expect(isLaunchSplashCovering()).toBe(false);
  });
});
