import { expect, it } from 'vitest';

import { leaveTouchToNativeView, touchBelongsToNativeView } from '../lib/native-touch-owner';

const touch = (pageY: number) => ({ nativeEvent: { pageX: 0, pageY } }) as never;

it('knows the touch a native view said was its own, and declines it for that view', () => {
  const onThePlayer = touch(300);
  expect(touchBelongsToNativeView(onThePlayer)).toBe(false);
  expect(leaveTouchToNativeView(onThePlayer)).toBe(false);
  expect(touchBelongsToNativeView(onThePlayer)).toBe(true);
});

it('knows it by the event itself, so a later touch at the same place is not it', () => {
  leaveTouchToNativeView(touch(300));
  expect(touchBelongsToNativeView(touch(300))).toBe(false);
});

it('forgets the one before when another is said', () => {
  const first = touch(300);
  const second = touch(310);
  leaveTouchToNativeView(first);
  leaveTouchToNativeView(second);
  expect(touchBelongsToNativeView(first)).toBe(false);
  expect(touchBelongsToNativeView(second)).toBe(true);
});

it('never takes an event with nothing native in it for one', () => {
  leaveTouchToNativeView({} as never);
  expect(touchBelongsToNativeView({} as never)).toBe(false);
});
