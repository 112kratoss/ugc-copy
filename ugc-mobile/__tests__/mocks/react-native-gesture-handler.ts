/**
 * Test double for `react-native-gesture-handler`. Its entry imports
 * react-native/index.js, whose Flow syntax vitest cannot parse. The app draws
 * its scroll view for the rows on a pager page (`components/pager-row-scroll-view.tsx`),
 * which only decides who takes a drag on Android, and no unit test can see
 * that: under test it is the suite's own React Native ScrollView, whatever
 * the suite's `vi.mock('react-native')` makes of it. Aliased globally in
 * vitest.config.ts.
 */
export { ScrollView } from 'react-native';

import React from 'react';

type GestureCallback = (...args: never[]) => unknown;
type MockGesture = {
  kind: string;
  callbacks: Record<string, GestureCallback>;
  config: Record<string, unknown[]>;
} & Record<string, unknown>;

/**
 * A gesture's builder: every configuring call returns the gesture, and the
 * callbacks it was given stay readable (`callbacks.onEnd`), so a suite can run
 * a gesture's own code against a hand-made event. Nothing here ever fires one.
 */
function makeGesture(kind: string): MockGesture {
  const target: MockGesture = { kind, callbacks: {}, config: {} };
  const self: MockGesture = new Proxy(target, {
    get(gesture, property: string) {
      if (property in gesture) return gesture[property];
      return (...args: unknown[]) => {
        if (property.startsWith('on') && typeof args[0] === 'function') gesture.callbacks[property] = args[0] as GestureCallback;
        else gesture.config[property] = args;
        return self;
      };
    },
  });
  return self;
}

export const Gesture = {
  Pan: () => makeGesture('pan'),
  Tap: () => makeGesture('tap'),
  Native: () => makeGesture('native'),
  Manual: () => makeGesture('manual'),
};

/** Renders its child under a host element that carries the gesture, so a suite can find it. */
export function GestureDetector({ gesture, children }: { gesture: unknown; children?: React.ReactNode }) {
  return React.createElement('gesture-detector', { gesture }, children);
}

export type PanGesture = ReturnType<typeof Gesture.Pan>;
