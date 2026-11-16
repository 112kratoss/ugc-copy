/**
 * Focus goes back to what opened a reel when the reel closes (a keyboard reader's place), and
 * shows there only as it showed when the reel opened.
 *
 * A tile's controls and frame show for keyboard focus in it (`:focus-visible`, globals.css). A
 * reel opened with the pointer and closed with Escape gave focus back by script right after a key,
 * which browsers draw as keyboard focus: the tile kept its controls once the pointer had left it
 * (review of #834). So a reel opened from an element that did not show keyboard focus gives focus
 * back without showing it: `focus({ focusVisible: false })` where the browser takes that option
 * (Chromium 145 does), and elsewhere the element is marked (`data-quiet-focus`), which the
 * controls and the frame skip until the reader moves on by keyboard or focus leaves it.
 */

/** On an element given focus back quietly where focus() cannot be told to: the tile's rules skip it. */
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
    element.removeEventListener('blur', release);
    window.removeEventListener('keydown', releaseOnNavigation, true);
    quietFocusReleases.delete(element);
  };
  const releaseOnNavigation = (event: KeyboardEvent) => {
    if (event.key === 'Tab' || event.key.startsWith('Arrow')) release();
  };
  element.addEventListener('blur', release);
  window.addEventListener('keydown', releaseOnNavigation, true);
  quietFocusReleases.set(element, release);
}

/** Gives focus back to `element`, showing it only when `showFocus` (the reel was opened from the keyboard). */
export function returnFocus(element: HTMLElement, { showFocus }: { showFocus: boolean }): void {
  if (!element.isConnected) return;
  if (showFocus) {
    element.focus();
    return;
  }
  if (honoursFocusVisibleOption()) {
    element.focus({ preventScroll: true, focusVisible: false } as FocusOptionsWithVisibility);
    return;
  }
  markQuietFocus(element);
  element.focus({ preventScroll: true });
}
