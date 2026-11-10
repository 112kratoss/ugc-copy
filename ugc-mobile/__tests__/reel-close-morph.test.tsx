(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the reel's page does as UIKit's zoom closes it into a tile
 * (components/reel-close-morph.tsx): it is cut down to the tile's part of its
 * picture, so that nothing of the page hangs outside the tile and fades there
 * over the feed (owner's recording of a Home card, 2026-11-10). The drawing is
 * Reanimated's and is filmed, not tested; this is when it starts, how far it
 * goes and when it is undone.
 */

type TransitionEvent = { data?: { closing?: boolean } };

const navigation = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: TransitionEvent) => void>>();
  const state = { focused: true };
  return {
    state,
    listeners,
    addListener(type: string, listener: (event: TransitionEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
      return () => listeners.get(type)?.delete(listener);
    },
    isFocused: () => state.focused,
    emit(type: string, data?: TransitionEvent['data']) {
      listeners.get(type)?.forEach((listener) => listener({ data }));
    },
  };
});

const transition = vi.hoisted(() => {
  const listeners = new Map<string, (state: { value: number }) => void>();
  let ids = 0;
  return {
    listeners,
    progress: {
      addListener(listener: (state: { value: number }) => void) {
        ids += 1;
        listeners.set(String(ids), listener);
        return String(ids);
      },
      removeListener(id: string) {
        listeners.delete(id);
      },
    },
    emit(value: number) {
      listeners.forEach((listener) => listener({ value }));
    },
  };
});

/** What the page was last asked to do: where to, and over how long (0 = at once). */
const timings = vi.hoisted(() => [] as { to: number; duration: number }[]);

vi.mock('expo-router', () => ({ useNavigation: () => navigation }));
vi.mock('react-native-screens', () => ({
  useTransitionProgress: () => ({ progress: transition.progress, closing: {}, goingForward: {} }),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  Easing: { out: (easing: unknown) => easing, cubic: 'cubic', quad: 'quad' },
  useAnimatedStyle: (style: () => object) => style(),
  useSharedValue: <T,>(value: T) => ({ value }),
  // lib/reel-close-flight.ts keeps its flight in these.
  makeMutable: <T,>(value: T) => ({ value }),
  runOnJS: <T,>(fn: T) => fn,
  runOnUI: <T,>(fn: T) => fn,
  // The value it is heading for stands in for the animation.
  withTiming: (to: number, config: { duration: number }) => {
    timings.push({ to, duration: config.duration });
    return to;
  },
}));

import {
  REEL_CLOSE_MORPH_BACK_MS,
  REEL_CLOSE_MORPH_FULL_AT,
  REEL_CLOSE_MORPH_MS,
  ReelCloseMorphCue,
  reelCloseMorphAt,
  startReelCloseMorph,
  type ReelCloseMorph,
} from '../components/reel-close-morph';
import {
  appleZoomTileShape,
  forgetAppleZoomSurface,
  holdAppleZoomReturnPicture,
  noteAppleZoomTileShape,
  releaseAppleZoomReturnPicture,
  resetAppleZoomReturnPictures,
  type AppleZoomTileShape,
} from '../lib/apple-zoom-surface';
import { createReelTouches, type ReelTouches } from '../lib/reel-touches';

const TILE: AppleZoomTileShape = { width: 358, height: 447, radius: 22 };
/** This reel, to the picture's own flight (lib/reel-close-flight.ts). */
const REEL = 7;
const fingers = (count: number) => ({ nativeEvent: { touches: { length: count } } });

const mounted: renderer.ReactTestRenderer[] = [];
let forgetTile: () => void = () => {};

function makeMorph(): ReelCloseMorph {
  return { progress: { value: 0 }, tile: { value: null } } as unknown as ReelCloseMorph;
}

function mountCue(morph: ReelCloseMorph, props: { enabled?: boolean; itemId?: string } = {}): ReelTouches {
  const touches = createReelTouches();
  renderer.act(() => {
    mounted.push(renderer.create(
      <ReelCloseMorphCue morph={morph} reelId={REEL} surfaceId="home" itemId={props.itemId ?? 'post-1'} touches={touches} enabled={props.enabled ?? true} />
    ));
  });
  return touches;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  // Long enough since the clock's start that no touch is "just before".
  vi.advanceTimersByTime(5000);
  timings.length = 0;
  holdAppleZoomReturnPicture('home', 'post-1');
  forgetTile = noteAppleZoomTileShape('home', 'post-1', TILE);
});

afterEach(() => {
  mounted.splice(0).forEach((tree) => renderer.act(() => tree.unmount()));
  navigation.listeners.clear();
  navigation.state.focused = true;
  transition.listeners.clear();
  resetAppleZoomReturnPictures();
  vi.useRealTimers();
});

describe('the tile\'s shape, for the reel that closes into it', () => {
  it('is what the tile last reported, and goes with the tile', () => {
    expect(appleZoomTileShape('home', 'post-1')).toEqual(TILE);
    const forget = noteAppleZoomTileShape('home', 'post-1', { ...TILE, height: 358 });
    expect(appleZoomTileShape('home', 'post-1')?.height).toBe(358);
    forget();
    expect(appleZoomTileShape('home', 'post-1')).toBeNull();
  });

  // Explore keeps a pinned copy of a tile beside the one in its grid.
  it('stays when another tile of the same post has reported since', () => {
    const forgetFirst = noteAppleZoomTileShape('home', 'post-3', TILE);
    const second = { ...TILE };
    noteAppleZoomTileShape('home', 'post-3', second);
    forgetFirst();
    expect(appleZoomTileShape('home', 'post-3')).toBe(second);
  });

  it('is none for a tile with no size, another post, or no surface', () => {
    noteAppleZoomTileShape('home', 'post-2', { width: 0, height: 0, radius: 0 });
    expect(appleZoomTileShape('home', 'post-2')).toBeNull();
    expect(appleZoomTileShape('explore', 'post-1')).toBeNull();
    expect(appleZoomTileShape(null, 'post-1')).toBeNull();
  });

  it('goes with its surface', () => {
    forgetAppleZoomSurface('home');
    expect(appleZoomTileShape('home', 'post-1')).toBeNull();
  });
});

describe('how far a dragged close cuts the page down', () => {
  it('is nothing at rest, all of it by a third of the way, and never more', () => {
    expect(reelCloseMorphAt(0)).toBe(0);
    expect(reelCloseMorphAt(-0.1)).toBe(0);
    expect(reelCloseMorphAt(REEL_CLOSE_MORPH_FULL_AT / 2)).toBeCloseTo(0.5);
    expect(reelCloseMorphAt(REEL_CLOSE_MORPH_FULL_AT)).toBe(1);
    expect(reelCloseMorphAt(1)).toBe(1);
  });
});

describe('a close no finger began (the bar\'s Back)', () => {
  it('cuts the page down at once, to the tile\'s shape', () => {
    const morph = makeMorph();
    mountCue(morph);
    navigation.emit('transitionStart', { closing: true });
    expect(morph.tile.value).toEqual(TILE);
    expect(morph.progress.value).toBe(1);
    expect(timings).toEqual([{ to: 1, duration: REEL_CLOSE_MORPH_MS }]);
  });

  it('does not wait on the transition\'s progress, which reaches JS late', () => {
    const morph = makeMorph();
    mountCue(morph);
    navigation.emit('transitionStart', { closing: true });
    expect(transition.listeners.size).toBe(0);
  });

  it('leaves the page whole when the tile does not hold the picture: the reel has not landed, and UIKit closes into another view', () => {
    releaseAppleZoomReturnPicture('home', 'post-1', false);
    const morph = makeMorph();
    mountCue(morph);
    navigation.emit('transitionStart', { closing: true });
    expect(morph.progress.value).toBe(0);
    expect(timings).toEqual([]);
  });

  it('leaves the page whole when the tile is not laid out', () => {
    forgetTile();
    const morph = makeMorph();
    mountCue(morph);
    navigation.emit('transitionStart', { closing: true });
    expect(morph.progress.value).toBe(0);
  });

  it('leaves the page whole for a video, whose tile holds nothing', () => {
    const morph = makeMorph();
    mountCue(morph, { enabled: false });
    navigation.emit('transitionStart', { closing: true });
    expect(morph.progress.value).toBe(0);
  });

  it('says nothing when a screen is pushed over the reel', () => {
    const morph = makeMorph();
    mountCue(morph);
    navigation.state.focused = false;
    navigation.emit('transitionStart', { closing: true });
    expect(morph.progress.value).toBe(0);
  });
});

describe('a close a finger began (the edge swipe, a drag down)', () => {
  it('follows the close\'s progress, so the page thins as the finger pulls it away', () => {
    const morph = makeMorph();
    const touches = mountCue(morph);
    touches.handlers.onTouchStart(fingers(1));
    navigation.emit('transitionStart', { closing: true });
    // Nothing yet: the finger has not moved the close.
    expect(morph.progress.value).toBe(0);
    transition.emit(REEL_CLOSE_MORPH_FULL_AT / 2);
    expect(morph.tile.value).toEqual(TILE);
    expect(morph.progress.value).toBeCloseTo(0.5);
    transition.emit(0.9);
    expect(morph.progress.value).toBe(1);
    // Pulled back toward the reel.
    transition.emit(REEL_CLOSE_MORPH_FULL_AT / 4);
    expect(morph.progress.value).toBeCloseTo(0.25);
  });

  // UIKit's gesture takes the touch from React Native as it recognizes: the
  // finger is still on the glass, and React Native has been told it left.
  it('counts a touch that ended just before the close was heard of', () => {
    const morph = makeMorph();
    const touches = mountCue(morph);
    touches.handlers.onTouchStart(fingers(1));
    touches.handlers.onTouchCancel(fingers(0));
    vi.advanceTimersByTime(120);
    navigation.emit('transitionStart', { closing: true });
    expect(morph.progress.value).toBe(0);
    transition.emit(0.1);
    expect(morph.progress.value).toBeCloseTo(0.1 / REEL_CLOSE_MORPH_FULL_AT);
  });

  it('does not count a touch long over', () => {
    const morph = makeMorph();
    const touches = mountCue(morph);
    touches.handlers.onTouchStart(fingers(1));
    touches.handlers.onTouchEnd(fingers(0));
    vi.advanceTimersByTime(2000);
    navigation.emit('transitionStart', { closing: true });
    expect(morph.progress.value).toBe(1);
  });
});

describe('a close let go of before it commits', () => {
  it('brings the page back, and the next close cuts it down again', () => {
    const morph = makeMorph();
    mountCue(morph);
    navigation.emit('transitionStart', { closing: true });
    navigation.emit('gestureCancel');
    expect(morph.progress.value).toBe(0);
    expect(timings.at(-1)).toEqual({ to: 0, duration: REEL_CLOSE_MORPH_BACK_MS });
    navigation.emit('transitionStart', { closing: true });
    expect(morph.progress.value).toBe(1);
  });

  it('stops following the progress', () => {
    const morph = makeMorph();
    const touches = mountCue(morph);
    touches.handlers.onTouchStart(fingers(1));
    navigation.emit('transitionStart', { closing: true });
    transition.emit(0.2);
    navigation.emit('transitionEnd', { closing: false });
    expect(transition.listeners.size).toBe(0);
    expect(morph.progress.value).toBe(0);
  });

  it('touches nothing when the page was never cut down', () => {
    releaseAppleZoomReturnPicture('home', 'post-1', false);
    const morph = makeMorph();
    mountCue(morph);
    navigation.emit('transitionStart', { closing: true });
    navigation.emit('gestureCancel');
    expect(timings).toEqual([]);
  });
});

describe('the reader moves on mid-close', () => {
  it('leaves the page whole for the next post', () => {
    const morph = makeMorph();
    mountCue(morph);
    navigation.emit('transitionStart', { closing: true });
    expect(morph.progress.value).toBe(1);
    renderer.act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
    expect(morph.progress.value).toBe(0);
  });
});

describe('the reel\'s own Back, whose pop draws the page from a snapshot', () => {
  it('cuts the page down at once, with no animation to be caught half way', () => {
    const morph = makeMorph();
    expect(startReelCloseMorph(morph, 'home', 'post-1')).toBe(true);
    expect(morph.tile.value).toEqual(TILE);
    expect(morph.progress.value).toBe(1);
    expect(timings).toEqual([]);
  });

  it('does nothing without a tile that holds the picture and is laid out', () => {
    const morph = makeMorph();
    expect(startReelCloseMorph(morph, 'home', 'post-2')).toBe(false);
    expect(startReelCloseMorph(morph, null, 'post-1')).toBe(false);
    forgetTile();
    expect(startReelCloseMorph(morph, 'home', 'post-1')).toBe(false);
    expect(morph.progress.value).toBe(0);
  });
});
