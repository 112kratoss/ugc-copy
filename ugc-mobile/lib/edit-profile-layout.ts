const CLOSED_KEYBOARD_EXTRA_PADDING = 28;

/**
 * Resting bottom padding for the edit-profile form.
 *
 * Keyboard avoidance is no longer computed here: `KeyboardAwareContent` grows
 * the form in step with the keyboard frame, whereas this module could only
 * react to `keyboardDidShow` — which fires after the keyboard has finished
 * animating, so the form jumped into place a beat late.
 */
export function getEditProfileScrollPadding({ bottomInset }: { bottomInset: number }) {
  return bottomInset + CLOSED_KEYBOARD_EXTRA_PADDING;
}
