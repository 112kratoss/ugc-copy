import { expect, it, vi } from 'vitest';

import { leaveTouchToNativeView, touchBelongsToNativeView } from '../lib/native-touch-owner';

/** One event of a touch. Every one names the view that was under the finger when it came down. */
const touchOn = (target: number, pageY = 0) => ({ nativeEvent: { target, pageX: 0, pageY }, stopPropagation: vi.fn() });

it('declines the touch for the native view, and has nothing above it asked', () => {
  const start = touchOn(41);
  expect(leaveTouchToNativeView(start as never)).toBe(false);
  // Asked, something above takes it, and never hears a touch on the seek bar end.
  expect(start.stopPropagation).toHaveBeenCalledOnce();
});

it('knows the touch a native view said was its own, at its start and at each later move', () => {
  const start = touchOn(43, 300);
  expect(touchBelongsToNativeView(start as never)).toBe(false);
  leaveTouchToNativeView(start as never);
  expect(touchBelongsToNativeView(start as never)).toBe(true);
  // A move is another event of the same touch, on the same view.
  expect(touchBelongsToNativeView(touchOn(43, 312) as never)).toBe(true);
});

it('does not take a touch on another view for it', () => {
  leaveTouchToNativeView(touchOn(45) as never);
  expect(touchBelongsToNativeView(touchOn(57) as never)).toBe(false);
});

it('never takes an event with nothing native in it for one', () => {
  leaveTouchToNativeView({ stopPropagation: () => {} } as never);
  expect(touchBelongsToNativeView({} as never)).toBe(false);
  expect(touchBelongsToNativeView({ nativeEvent: {} } as never)).toBe(false);
});
