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
