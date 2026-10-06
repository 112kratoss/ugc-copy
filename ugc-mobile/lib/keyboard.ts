/**
 * Shared keyboard-avoidance geometry.
 *
 * Apple's keyboard layout guide keeps "important parts of your interface
 * visible while the virtual keyboard is onscreen" — the focused field and its
 * submit control stay clear of the keyboard instead of being covered by it.
 * This is the maths behind that, kept free of react-native imports so it stays
 * unit-testable in Node.
 *
 * It carries the `'worklet'` directive so Reanimated can call it straight from
 * a UI-thread animated style; without it, calling an imported helper inside
 * `useAnimatedStyle` throws at runtime. The directive is an inert string
 * expression under vitest.
 */

/**
 * How far a surface gives way to the keyboard.
 *
 * Used two ways: a scroll area shrinks its height by this much so the platform
 * scrolls the focused field back into view, and a bottom-pinned bar travels
 * this far upward to ride on top of the keys.
 *
 * A surface that already clears the home indicator passes that inset as
 * `reservedBottomInset`. The keyboard covers that same region once open, so the
 * inset is subtracted rather than added — otherwise the surface overshoots by
 * the height of the indicator.
 */
export function getKeyboardLift({
  keyboardHeight,
  reservedBottomInset = 0,
}: {
  keyboardHeight: number;
  reservedBottomInset?: number;
}) {
  'worklet';

  // `!(x > 0)` rather than `x <= 0` so a NaN height collapses to no lift
  // instead of poisoning the layout with NaN.
  if (!(keyboardHeight > 0)) return 0;

  return Math.max(0, keyboardHeight - reservedBottomInset);
}

/**
 * The keyboard height to give way to, chosen between the two sources that track it.
 *
 * Reanimated's tracker follows the keyboard frame by frame, but on Android it
 * learns the keyboard has closed only from a closing animation. A keyboard that
 * leaves without one, because a native Modal (a dialog, the parameters sheet) or
 * another app's window took focus while it was open, leaves the tracker at the
 * old height until the next animation, and the screen keeps a keyboard-sized
 * black hole with no keyboard in it. React Native's keyboard events read the
 * window's insets on every layout, so they see that hide.
 *
 * So the tracker leads while the keyboard moves, keeping the surface in step with
 * the keys; a reported hide is believed for as long as the tracker has not moved
 * since; and otherwise the larger source wins, which still covers a keyboard the
 * tracker never saw open.
 *
 * The tracker's own state (OPEN, CLOSING, …) is deliberately not asked. It is
 * settled by counting the starts and ends of keyboard animations, and
 * Reanimated stops listening when its last subscriber unmounts: a sheet that
 * closes with the keyboard up takes its area away before the keys have finished
 * leaving, the end is never counted, and from then on the state reads OPENING
 * or CLOSING for the rest of the process with the keyboard standing still
 * (Reanimated 4.2.1, Pixel 9a emulator, 2026-10-05). The rule used to wait for
 * a tracker "settled open", and after that it never fired again: under a dialog
 * the resource editor stayed shortened over an empty band.
 */
export function resolveKeyboardHeight({
  trackedHeight,
  reportedHeight,
  reportedHidden,
}: {
  /** `useAnimatedKeyboard().height`. */
  trackedHeight: number;
  /** The height from React Native's keyboard events, eased toward its target. */
  reportedHeight: number;
  /** Whether those events last said the keyboard is hidden, and the tracker has not moved since. */
  reportedHidden: boolean;
}) {
  'worklet';

  if (reportedHidden) return reportedHeight;

  return Math.max(trackedHeight, reportedHeight);
}
