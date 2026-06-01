const CLOSED_KEYBOARD_EXTRA_PADDING = 28;
const OPEN_KEYBOARD_EXTRA_PADDING = 24;

export function getEditProfileScrollPadding({
  bottomInset,
  keyboardHeight,
}: {
  bottomInset: number;
  keyboardHeight: number;
}) {
  const closedPadding = bottomInset + CLOSED_KEYBOARD_EXTRA_PADDING;
  if (keyboardHeight <= 0) return closedPadding;

  return Math.max(closedPadding, keyboardHeight + OPEN_KEYBOARD_EXTRA_PADDING);
}
