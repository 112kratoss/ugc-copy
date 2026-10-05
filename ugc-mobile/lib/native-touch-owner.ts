import type { GestureResponderEvent } from 'react-native';

/**
 * A touch that began on a native view with touch handling of its own: a
 * player's controls.
 *
 * On Android such a view keeps its touch only while no React view holds it for
 * JS. Once one does, React Native has that view intercept the native touch at
 * the finger's first movement, and the native view under it is sent a cancel.
 * A sheet's drag takes every touch-down that nothing below it wanted, so in
 * the Reference details sheet a finger on the player's play button did nothing,
 * while a tap with no movement played (S24 and the emulator, 2026-10-05).
 *
 * The native view therefore says the touch is its own, and whatever would take
 * any touch-down asks here first and leaves it. The view says so by answering
 * the start question: it is asked before anything above it, notes the touch
 * and declines it.
 *
 * Having the view claim the touch instead was built first and looked right: the
 * buttons answered. But the player's view tells JS when a touch starts and,
 * for a drag on its seek bar, never that it ended. It stayed the holder, and
 * the next press on any button, on any page, was ignored once (3 of 3 on the
 * emulator, against 0 of 3 with nothing claimed).
 */
let nativeTouchStart: object | null = null;

/** For a native view's `onStartShouldSetResponder`: notes the touch as its own and declines it. */
export function leaveTouchToNativeView(event: GestureResponderEvent) {
  nativeTouchStart = event.nativeEvent ?? null;
  return false;
}

/** Whether this touch-down is one a native view below has said it handles itself. */
export function touchBelongsToNativeView(event: GestureResponderEvent) {
  return event.nativeEvent != null && event.nativeEvent === nativeTouchStart;
}
