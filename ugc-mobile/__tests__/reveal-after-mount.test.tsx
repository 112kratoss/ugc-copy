// Define React Native development globals for react-test-renderer.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reveal's `afterMount` (2026-11-14): search's ideas to start from took longer than a frame to
// mount, and the fade's first frame, started with the mount, was late on the iPhone. With
// afterMount the fade starts two frames after the mount instead.
const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('react-native', () => {
  class Value {
    value: number;
    constructor(value: number) { this.value = value; }
    setValue(value: number) { this.value = value; }
    interpolate() { return this; }
  }
  return {
    Animated: { Value, timing: () => ({ start: mocks.start, stop: mocks.stop }) },
    Easing: { out: (curve: unknown) => curve, cubic: (t: number) => t },
    View: (props: Record<string, unknown>) => React.createElement('view', props),
  };
});
vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('motion-view', props, children),
  useReducedMotion: () => false,
}));

import { Reveal } from '../components/reveal';

describe('Reveal after mount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.start.mockClear();
    mocks.stop.mockClear();
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('starts the fade with the mount by default', async () => {
    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => { tree = renderer.create(React.createElement(Reveal, { children: 'content' })); });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    await act(async () => tree!.unmount());
  });

  it('starts it two frames after the mount with afterMount, and never once unmounted', async () => {
    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => { tree = renderer.create(React.createElement(Reveal, { afterMount: true, children: 'content' })); });
    expect(mocks.start).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(16); });
    expect(mocks.start).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(16); });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    await act(async () => tree!.unmount());

    mocks.start.mockClear();
    let gone: renderer.ReactTestRenderer | null = null;
    await act(async () => { gone = renderer.create(React.createElement(Reveal, { afterMount: true, children: 'content' })); });
    await act(async () => gone!.unmount());
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
