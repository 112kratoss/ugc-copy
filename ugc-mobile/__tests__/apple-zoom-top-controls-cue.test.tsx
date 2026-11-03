(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * When the reel's Back and sound controls show on a reel UIKit's zoom opened
 * (`AppleZoomTopControlsCue`, components/apple-zoom-progress.ios.tsx): once the
 * push has crossfaded to the reel, read from its progress reaching 0.9 or a
 * 700 ms deadline; gone from the start of a close until it is let go of, and
 * for good from Back. A screen pushed over the reel leaves them alone.
 */

type TransitionEvent = { data?: { closing?: boolean } };

// The navigator, as the reel sees it: its events fired from the test.
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

// The push's progress, which react-native-screens drives from UIKit's
// transition: a listener on it is told every frame's value.
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

vi.mock('expo-router', () => ({ useNavigation: () => navigation }));
vi.mock('react-native', () => ({ Animated: {} }));
vi.mock('react-native-screens', () => ({
  useTransitionProgress: () => ({ progress: transition.progress, closing: {}, goingForward: {} }),
}));
vi.mock('@/lib/zoom-veil', () => ({ followZoomVeilTransition: () => () => {} }));

import { AppleZoomTopControlsCue } from '../components/apple-zoom-progress.ios';

const DEADLINE_MS = 700;

const mounted: renderer.ReactTestRenderer[] = [];

afterEach(() => {
  mounted.splice(0).forEach((tree) => renderer.act(() => tree.unmount()));
  navigation.listeners.clear();
  navigation.state.focused = true;
  transition.listeners.clear();
  vi.useRealTimers();
});

function mountCue() {
  const seen: boolean[] = [];
  const onShownChange = (shown: boolean) => {
    seen.push(shown);
  };
  renderer.act(() => {
    mounted.push(renderer.create(<AppleZoomTopControlsCue onShownChange={onShownChange} />));
  });
  return {
    /** What the controls were last told: hidden until told otherwise. */
    shown: () => seen.at(-1) ?? false,
    seen,
  };
}

const fire = (type: string, data?: TransitionEvent['data']) => renderer.act(() => navigation.emit(type, data));
const progress = (value: number) => renderer.act(() => transition.emit(value));
const wait = (ms: number) => renderer.act(() => { vi.advanceTimersByTime(ms); });

describe('the reel\'s top controls under UIKit\'s zoom', () => {
  it('come in once the push has crossfaded: at 0.9 of its progress, not before', () => {
    const cue = mountCue();
    expect(cue.shown()).toBe(false);
    progress(0.5);
    progress(0.89);
    expect(cue.shown()).toBe(false);
    progress(0.9);
    expect(cue.shown()).toBe(true);
  });

  it('come in at the deadline when the push never reports 0.9', () => {
    vi.useFakeTimers();
    const cue = mountCue();
    wait(DEADLINE_MS - 1);
    expect(cue.shown()).toBe(false);
    wait(1);
    expect(cue.shown()).toBe(true);
  });

  it('stop listening to the push once they are in: a listener there is a JS event every frame', () => {
    vi.useFakeTimers();
    const cue = mountCue();
    expect(transition.listeners.size).toBe(1);
    progress(0.95);
    expect(transition.listeners.size).toBe(0);
    const told = cue.seen.length;
    wait(DEADLINE_MS);
    expect(cue.seen).toHaveLength(told);
  });

  it('go as Back begins, and stay gone', () => {
    const cue = mountCue();
    progress(1);
    fire('beforeRemove');
    expect(cue.shown()).toBe(false);
    // Nothing the closing reel still hears brings them back.
    fire('transitionStart', { closing: false });
    fire('transitionEnd', { closing: false });
    fire('gestureCancel');
    expect(cue.shown()).toBe(false);
  });

  it('go as the reader begins a close, and come back when it is let go of', () => {
    const cue = mountCue();
    progress(1);
    fire('transitionStart', { closing: true });
    expect(cue.shown()).toBe(false);
    fire('gestureCancel');
    expect(cue.shown()).toBe(true);

    fire('transitionStart', { closing: true });
    expect(cue.shown()).toBe(false);
    fire('transitionStart', { closing: false });
    fire('transitionEnd', { closing: false });
    expect(cue.shown()).toBe(true);
  });

  it('stay through a screen pushed over the reel and popped off it, the reel no longer the focused route', () => {
    const cue = mountCue();
    progress(1);
    const told = cue.seen.length;
    navigation.state.focused = false;
    fire('transitionStart', { closing: true });
    fire('transitionEnd', { closing: true });
    navigation.state.focused = true;
    fire('transitionStart', { closing: false });
    fire('transitionEnd', { closing: false });
    expect(cue.seen.slice(told)).not.toContain(false);
    expect(cue.shown()).toBe(true);
  });

  // A close begun inside the first 700 ms — a swipe back straight after a
  // mis-tap, or Back — ran on into the push's own cue: the deadline fired, or
  // the close's progress passed 0.9, and the controls faded in over the
  // shrinking reel.
  describe('through a close begun before they came in', () => {
    it('stay gone from Back, whatever the deadline or the close\'s progress says', () => {
      vi.useFakeTimers();
      const cue = mountCue();
      wait(100);
      fire('beforeRemove');
      wait(DEADLINE_MS);
      progress(0.95);
      expect(cue.seen).not.toContain(true);
      // Nor is the push listened to any longer.
      expect(transition.listeners.size).toBe(0);
    });

    it('stay gone through a gesture close, and come in when it is let go of', () => {
      vi.useFakeTimers();
      const cue = mountCue();
      wait(100);
      fire('transitionStart', { closing: true });
      wait(DEADLINE_MS);
      progress(0.95);
      expect(cue.seen).not.toContain(true);
      expect(transition.listeners.size).toBe(0);
      fire('gestureCancel');
      expect(cue.shown()).toBe(true);
    });
  });
});
