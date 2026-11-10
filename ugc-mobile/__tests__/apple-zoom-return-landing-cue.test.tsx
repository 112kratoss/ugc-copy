(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * When a close has landed the reel in its tile (`AppleZoomReturnLandingCue`,
 * components/apple-zoom-progress.ios.tsx), which is when the tile's picture is
 * let go and the tile draws itself again, badges and all. UIKit reports the
 * end of its transition up to a second after the picture has stopped, so the
 * cue reads the transition's progress, the clock and whether a finger is on
 * the reel instead.
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

vi.mock('expo-router', () => ({ useNavigation: () => navigation }));
vi.mock('react-native', () => ({ Animated: {} }));
vi.mock('react-native-screens', () => ({
  useTransitionProgress: () => ({ progress: transition.progress, closing: {}, goingForward: {} }),
}));

import { AppleZoomReturnLandingCue } from '../components/apple-zoom-progress.ios';
import { APPLE_ZOOM_RETURN_LANDS_AFTER_MS, holdAppleZoomReturnPicture, isAppleZoomReturnPictureHeld, resetAppleZoomReturnPictures } from '../lib/apple-zoom-surface';
import { createReelTouches, type ReelTouches } from '../lib/reel-touches';

/** The time a close nothing holds is given, and how far its progress has to be. */
const LANDS_MS = APPLE_ZOOM_RETURN_LANDS_AFTER_MS;
const LANDED_AT = 0.99;
const fingers = (count: number) => ({ nativeEvent: { touches: { length: count } } });
const held = () => isAppleZoomReturnPictureHeld('explore', 'post-1');

const mounted: renderer.ReactTestRenderer[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
  holdAppleZoomReturnPicture('explore', 'post-1');
});

afterEach(() => {
  mounted.splice(0).forEach((tree) => renderer.act(() => tree.unmount()));
  navigation.listeners.clear();
  navigation.state.focused = true;
  transition.listeners.clear();
  resetAppleZoomReturnPictures();
  vi.useRealTimers();
});

function mountCue(surfaceId: string | null = 'explore'): ReelTouches {
  const touches = createReelTouches();
  renderer.act(() => {
    mounted.push(renderer.create(<AppleZoomReturnLandingCue surfaceId={surfaceId} itemId="post-1" touches={touches} />));
  });
  return touches;
}

const wait = (ms: number) => renderer.act(() => {
  vi.advanceTimersByTime(ms);
});

describe('when a close has landed the reel in its tile', () => {
  // The tile is under the reel's page, which UIKit fades only as the picture
  // nears home: shown sooner, the tile stood dimmed under what was left of it
  // (iPhone 16e, 2026-11-10).
  it('lets the picture go once Back\'s close has had its time and its progress is there', () => {
    mountCue();
    navigation.emit('transitionStart', { closing: true });
    wait(100);
    transition.emit(0.6);
    wait(190);
    transition.emit(LANDED_AT + 0.001);
    // Its progress is there a little before its time.
    expect(held()).toBe(true);
    wait(LANDS_MS - 290 - 1);
    expect(held()).toBe(true);
    wait(1);
    expect(held()).toBe(false);
  });

  it('waits for the progress when the time is up first', () => {
    mountCue();
    navigation.emit('transitionStart', { closing: true });
    wait(LANDS_MS + 50);
    expect(held()).toBe(true);
    transition.emit(LANDED_AT - 0.02);
    expect(held()).toBe(true);
    transition.emit(LANDED_AT);
    expect(held()).toBe(false);
  });

  it('holds on while a finger is dragging the close, however far it has dragged it', () => {
    const touches = mountCue();
    touches.handlers.onTouchStart(fingers(1));
    wait(130);
    navigation.emit('transitionStart', { closing: true });
    // Dragged all the way: the progress follows the finger.
    transition.emit(1);
    wait(2000);
    expect(held()).toBe(true);

    // Let go: the close has its time from here.
    touches.handlers.onTouchEnd(fingers(0));
    wait(LANDS_MS - 1);
    expect(held()).toBe(true);
    wait(1);
    expect(held()).toBe(false);
  });

  it('waits for a dragged close\'s progress as well as its time', () => {
    const touches = mountCue();
    touches.handlers.onTouchStart(fingers(1));
    navigation.emit('transitionStart', { closing: true });
    transition.emit(0.5);
    wait(200);
    touches.handlers.onTouchEnd(fingers(0));
    wait(LANDS_MS + 20);
    transition.emit(LANDED_AT - 0.02);
    expect(held()).toBe(true);
    transition.emit(LANDED_AT);
    expect(held()).toBe(false);
  });

  // A drag down that UIKit takes for a close only as the finger lifts: the
  // close has its time from its own start.
  it('counts from the close\'s start when the finger had already lifted', () => {
    const touches = mountCue();
    touches.handlers.onTouchStart(fingers(1));
    wait(500);
    touches.handlers.onTouchEnd(fingers(0));
    wait(40);
    navigation.emit('transitionStart', { closing: true });
    transition.emit(1);
    wait(LANDS_MS - 1);
    expect(held()).toBe(true);
    wait(1);
    expect(held()).toBe(false);
  });

  // UIKit lets a finger take hold of a close that is already running.
  it('starts its time again from the lift of a finger that caught the close', () => {
    const touches = mountCue();
    navigation.emit('transitionStart', { closing: true });
    wait(60);
    touches.handlers.onTouchStart(fingers(1));
    transition.emit(1);
    wait(LANDS_MS * 2);
    expect(held()).toBe(true);
    touches.handlers.onTouchEnd(fingers(0));
    wait(LANDS_MS - 1);
    expect(held()).toBe(true);
    wait(1);
    expect(held()).toBe(false);
  });

  it('lands nothing when the reader lets go of a close before it commits', () => {
    const touches = mountCue();
    touches.handlers.onTouchStart(fingers(1));
    navigation.emit('transitionStart', { closing: true });
    transition.emit(0.3);
    touches.handlers.onTouchEnd(fingers(0));
    wait(100);
    // The reel is back.
    navigation.emit('gestureCancel');
    transition.emit(1);
    wait(LANDS_MS * 2);
    expect(held()).toBe(true);
    // And listens to nothing until the next close.
    expect(transition.listeners.size).toBe(0);
  });

  // The page reached its tile and the picture was let go, and then the close
  // was let go of after all: the reel is back, showing the same picture, and
  // its next close has to carry it.
  it('holds the picture again when a close it had already landed is let go of', () => {
    const touches = mountCue();
    touches.handlers.onTouchStart(fingers(1));
    navigation.emit('transitionStart', { closing: true });
    transition.emit(1);
    touches.handlers.onTouchEnd(fingers(0));
    wait(LANDS_MS);
    expect(held()).toBe(false);

    navigation.emit('gestureCancel');
    expect(held()).toBe(true);

    // And the next close lands it as before.
    navigation.emit('transitionStart', { closing: true });
    transition.emit(1);
    wait(LANDS_MS);
    expect(held()).toBe(false);
  });

  it('holds nothing again for a reel whose picture was not held', () => {
    mountCue();
    resetAppleZoomReturnPictures();
    navigation.emit('transitionStart', { closing: true });
    transition.emit(1);
    wait(LANDS_MS);
    navigation.emit('gestureCancel');
    expect(held()).toBe(false);
  });

  // React Native cancels a touch a gesture outside it takes over, and no lift
  // follows for that finger, which may still be dragging the close.
  it('leaves a close whose finger React Native lost by a cancel to land when the reel goes', () => {
    const touches = mountCue();
    touches.handlers.onTouchStart(fingers(1));
    wait(100);
    // Cancelled as the gesture recognized, just before the close is heard of.
    touches.handlers.onTouchCancel(fingers(0));
    wait(50);
    navigation.emit('transitionStart', { closing: true });
    transition.emit(1);
    wait(LANDS_MS * 4);
    expect(held()).toBe(true);
  });

  it('pays no mind to a cancel long before the close', () => {
    const touches = mountCue();
    touches.handlers.onTouchStart(fingers(1));
    touches.handlers.onTouchCancel(fingers(0));
    wait(5000);
    navigation.emit('transitionStart', { closing: true });
    transition.emit(1);
    wait(LANDS_MS);
    expect(held()).toBe(false);
  });

  it('lands the close that follows one the reader let go of', () => {
    const touches = mountCue();
    touches.handlers.onTouchStart(fingers(1));
    navigation.emit('transitionStart', { closing: true });
    touches.handlers.onTouchEnd(fingers(0));
    navigation.emit('transitionStart', { closing: false });
    wait(1000);

    navigation.emit('transitionStart', { closing: true });
    transition.emit(1);
    wait(LANDS_MS);
    expect(held()).toBe(false);
  });

  it('leaves the picture alone when a screen is pushed over the reel', () => {
    mountCue();
    // The same event, with the reel no longer the focused route.
    navigation.state.focused = false;
    navigation.emit('transitionStart', { closing: true });
    transition.emit(1);
    wait(LANDS_MS * 2);
    expect(held()).toBe(true);
    expect(transition.listeners.size).toBe(0);
  });

  it('does nothing on a reel that did not come out of a tile', () => {
    mountCue(null);
    expect(navigation.listeners.size).toBe(0);
  });

  it('stops listening when the reel goes', () => {
    mountCue();
    navigation.emit('transitionStart', { closing: true });
    expect(transition.listeners.size).toBe(1);
    mounted.splice(0).forEach((tree) => renderer.act(() => tree.unmount()));
    expect(transition.listeners.size).toBe(0);
    wait(LANDS_MS * 2);
    expect(held()).toBe(true);
  });
});
