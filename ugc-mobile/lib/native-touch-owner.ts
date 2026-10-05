import type { GestureResponderEvent } from 'react-native';

/**
 * A touch on a native view with touch handling of its own: a player's
 * controls.
 *
 * On Android such a view keeps its touch only while no React view holds it for
 * JS. Once one does, React Native has that view intercept the native touch at
 * the finger's first movement, and the native view under it is sent a cancel.
 * A sheet's drag takes every touch-down that nothing below it wanted, so in
 * the Reference details sheet a finger on the player's play button did nothing,
 * while a tap with no movement played (S24 and the emulator, 2026-10-05).
 *
 * A holder that intercepts nothing is no better. The player's view tells JS
 * when a touch on it starts and, for a touch on its seek bar, never that it
 * ended: the seek bar asks the views above it not to intercept its touch, and
 * the view reports to JS from the very hook that request switches off. So
 * whatever holds the touch goes on holding it, and React asks nothing below a
 * holder about the next touch, which is lost. Only that touch's end lets the
 * holder go; JS cannot. Inside a Modal the holder was React Native's own Modal
 * host, which takes every touch-down that reaches it: after a touch on the
 * seek bar the next press on a button of the sheet did nothing, nor the next
 * pull on the sheet, nor the first press on the page behind once BACK had
 * closed it (Pixel 9a emulator, 2026-10-05; the same in the result sheet and
 * the lightbox). On a page it was the scroll view, which while the keyboard
 * is up takes a touch-down no child wanted, to put the keyboard away when it
 * ends. Having the view hold its own touch was tried first, and lost the next
 * press the same way on every page.
 *
 * So the view answers the start question for itself. It is asked before
 * anything above it: it notes the touch, declines it, and stops the question
 * there, so that nothing above is asked and nothing holds the touch.
 *
 * The question is put again at each move JS hears of, to everything above the
 * view, and a sheet's drag takes a touch once it has moved down a little: a
 * finger that slid on the play button as it pressed. So whatever takes a
 * moving touch asks here first, and leaves the view's. A touch is known by
 * the view it is on, which every one of its events names.
 */
let nativeTouchTarget: unknown = null;

/** For a native view's `onStartShouldSetResponder`: notes the touch as its own, declines it, and has nothing above asked. */
export function leaveTouchToNativeView(event: GestureResponderEvent) {
  nativeTouchTarget = event.nativeEvent?.target ?? null;
  event.stopPropagation();
  return false;
}

/** Whether this touch, at its start or at a later move, is on a native view that has said it handles its own. */
export function touchBelongsToNativeView(event: GestureResponderEvent) {
  const target = event.nativeEvent?.target;
  return target != null && target === nativeTouchTarget;
}
