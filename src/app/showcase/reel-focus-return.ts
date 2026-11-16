/**
 * Focus goes back to what opened a reel when the reel closes (a keyboard reader's place), and
 * shows there only as it showed when the reel opened.
 *
 * A tile's controls and frame show for keyboard focus in it (`:focus-visible`, globals.css). A
 * reel opened with the pointer and closed with Escape gave focus back by script right after a key,
 * which browsers draw as keyboard focus: the tile kept its controls once the pointer had left it
 * (review of #834). So a reel opened from an element that did not show keyboard focus gives focus
 * back without showing it: `focus({ focusVisible: false })` where the browser takes that option
 * (Chromium 145 does), for the browser's own ring, and in every browser the element is marked
 * (`data-quiet-focus`), which the controls and the frame skip until the reader moves on: a Tab or
 * an arrow key, a press of the pointer, or focus moving elsewhere in the page. A key that moves
 * nothing (Escape again, End) leaves it marked, wherever a browser would draw it as keyboard focus
 * again.
 */

/** On an element given focus back quietly: the tile's rules skip it. */
export const QUIET_FOCUS_ATTRIBUTE = 'data-quiet-focus';

type FocusOptionsWithVisibility = FocusOptions & { focusVisible?: boolean };

/** Whether this browser reads `focusVisible` in focus()'s options; asked of a detached element, which takes no focus. */
function honoursFocusVisibleOption(): boolean {
  let read = false;
  try {
    document.createElement('button').focus({
      get focusVisible() {
        read = true;
        return false;
      },
    } as FocusOptionsWithVisibility);
  } catch {
    return false;
  }
  return read;
}

/** Whether `element` shows keyboard focus now: a reel opened from it by keyboard gives focus back as it was. */
export function showsKeyboardFocus(element: Element): boolean {
  if (element.hasAttribute(QUIET_FOCUS_ATTRIBUTE)) return false;
  try {
    return element.matches(':focus-visible');
  } catch {
    // A browser that cannot tell gives focus back as it always has.
    return true;
  }
}

const quietFocusReleases = new WeakMap<HTMLElement, () => void>();

function markQuietFocus(element: HTMLElement): void {
  quietFocusReleases.get(element)?.();
  element.setAttribute(QUIET_FOCUS_ATTRIBUTE, '');
  const release = () => {
    element.removeAttribute(QUIET_FOCUS_ATTRIBUTE);
    element.removeEventListener('blur', releaseOnFocusMove);
    window.removeEventListener('keydown', releaseOnNavigation, true);
    window.removeEventListener('pointerdown', release, true);
    quietFocusReleases.delete(element);
  };
  // Focus moving elsewhere in the page. The window losing focus (another app) blurs the element
  // too, and gives it back on return: that keeps the mark.
  const releaseOnFocusMove = () => {
    if (element.ownerDocument.hasFocus()) release();
  };
  const releaseOnNavigation = (event: KeyboardEvent) => {
    // An element taken out of the page is let go at the next key, whatever it is. Autofill can
    // send a keydown with no key.
    if (!element.isConnected || event.key === 'Tab' || event.key?.startsWith('Arrow')) release();
  };
  element.addEventListener('blur', releaseOnFocusMove);
  window.addEventListener('keydown', releaseOnNavigation, true);
  window.addEventListener('pointerdown', release, true);
  quietFocusReleases.set(element, release);
}

/** Gives focus back to `element`, showing it only when `showFocus` (the reel was opened from the keyboard). */
export function returnFocus(element: HTMLElement, { showFocus }: { showFocus: boolean }): void {
  // The page itself held no focus to give back (nothing was focused, or a browser that does not
  // focus a pressed button).
  if (!element.isConnected || element === element.ownerDocument.body) return;
  if (showFocus) {
    element.focus();
    return;
  }
  element.focus(honoursFocusVisibleOption()
    ? { preventScroll: true, focusVisible: false } as FocusOptionsWithVisibility
    : { preventScroll: true });
  // Marked only once it holds focus: an element that cannot take it has nothing to keep quiet.
  if (element.ownerDocument.activeElement === element) markQuietFocus(element);
}
