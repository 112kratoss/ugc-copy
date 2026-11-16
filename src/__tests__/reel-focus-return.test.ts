import { afterEach, describe, expect, it, vi } from 'vitest';

import { QUIET_FOCUS_ATTRIBUTE, returnFocus, showsKeyboardFocus } from '@/app/showcase/reel-focus-return';

// Focus goes back to what opened a reel when it closes, shown only as it showed when the reel
// opened (review of #834: a reel opened with the pointer and closed with Escape left its tile's
// controls on). tests/e2e/explore-reel-open.spec.ts draws both paths in Chromium; here the parts a
// browser cannot be asked to switch: what focus() is called with, and when the mark goes.

function tile(): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = 'Harbour in the rain';
  document.body.append(button);
  return button;
}

const marked = (element: Element) => element.hasAttribute(QUIET_FOCUS_ATTRIBUTE);
const key = (name: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: name }));

/** The keydown and pointerdown listeners the window holds, added less removed. */
function windowListeners() {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  return (type: string) => add.mock.calls.filter(([added]) => added === type).length
    - remove.mock.calls.filter(([removed]) => removed === type).length;
}

afterEach(() => {
  // Let go of whatever is still marked, then of the spies.
  key('Tab');
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('returnFocus', () => {
  it('gives focus back as it was to a reel opened from the keyboard, and marks nothing', () => {
    const opener = tile();
    const focus = vi.spyOn(opener, 'focus');

    returnFocus(opener, { showFocus: true });

    expect(focus).toHaveBeenCalledWith();
    expect(document.activeElement).toBe(opener);
    expect(marked(opener)).toBe(false);
  });

  it('tells focus() not to show it where the browser takes focusVisible, and marks it as well', () => {
    const opener = tile();
    const original = HTMLElement.prototype.focus;
    const calls: Array<FocusOptions & { focusVisible?: boolean }> = [];
    // A browser that reads the option, as Chromium 145 does.
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions & { focusVisible?: boolean }) {
      void options?.focusVisible;
      if (options) calls.push({ preventScroll: options.preventScroll, focusVisible: options.focusVisible });
      original.call(this, options);
    });

    returnFocus(opener, { showFocus: false });

    // The browser's own ring stays off...
    expect(calls.at(-1)).toEqual({ preventScroll: true, focusVisible: false });
    expect(document.activeElement).toBe(opener);
    // ...and the tile's rules skip it, should a later key draw it as keyboard focus after all.
    expect(marked(opener)).toBe(true);
    expect(showsKeyboardFocus(opener)).toBe(false);
  });

  it('where focus() cannot be told (jsdom reads no focusVisible), focuses without scrolling and marks', () => {
    const opener = tile();
    const focus = vi.spyOn(opener, 'focus');

    returnFocus(opener, { showFocus: false });

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(opener);
    expect(marked(opener)).toBe(true);
  });

  it('keeps the mark through keys that move nothing, and lets go on a Tab or an arrow key', () => {
    const first = tile();
    returnFocus(first, { showFocus: false });
    for (const name of ['Escape', 'End', 'PageDown', 'Enter', 'a']) key(name);
    expect(marked(first)).toBe(true);
    key('Tab');
    expect(marked(first)).toBe(false);

    const second = tile();
    returnFocus(second, { showFocus: false });
    key('ArrowDown');
    expect(marked(second)).toBe(false);
  });

  it('lets go on a press of the pointer anywhere', () => {
    const opener = tile();
    returnFocus(opener, { showFocus: false });

    window.dispatchEvent(new Event('pointerdown'));

    expect(marked(opener)).toBe(false);
  });

  it('lets go when focus moves elsewhere in the page, not when the window loses focus', () => {
    const opener = tile();
    returnFocus(opener, { showFocus: false });
    const hasFocus = vi.spyOn(document, 'hasFocus');

    // Another app came forward: the element is blurred, and focused again on the way back.
    hasFocus.mockReturnValue(false);
    opener.dispatchEvent(new FocusEvent('blur'));
    expect(marked(opener)).toBe(true);

    hasFocus.mockReturnValue(true);
    opener.blur();
    expect(marked(opener)).toBe(false);
  });

  it('lets go of an element taken out of the page at the next key, whatever it is', () => {
    const listening = windowListeners();
    const opener = tile();
    returnFocus(opener, { showFocus: false });
    expect(listening('keydown')).toBe(1);
    expect(listening('pointerdown')).toBe(1);

    opener.remove();
    key('Escape');

    expect(marked(opener)).toBe(false);
    expect(listening('keydown')).toBe(0);
    expect(listening('pointerdown')).toBe(0);
  });

  it('takes a keydown with no key (autofill sends one) without an error, and keeps the mark', () => {
    const opener = tile();
    returnFocus(opener, { showFocus: false });
    // An error in a listener reaches the window as an error event, not the dispatch.
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', onError);

    window.dispatchEvent(new Event('keydown'));

    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(marked(opener)).toBe(true);
  });

  it('marks an element once however often focus goes back to it', () => {
    const listening = windowListeners();
    const opener = tile();

    returnFocus(opener, { showFocus: false });
    returnFocus(opener, { showFocus: false });

    expect(listening('keydown')).toBe(1);
    expect(listening('pointerdown')).toBe(1);
    key('Tab');
    expect(marked(opener)).toBe(false);
  });

  it('marks nothing that did not take focus: an element that cannot hold it, or the page itself', () => {
    const plain = document.createElement('div');
    document.body.append(plain);
    returnFocus(plain, { showFocus: false });
    expect(document.activeElement).not.toBe(plain);
    expect(marked(plain)).toBe(false);

    const focus = vi.spyOn(document.body, 'focus');
    returnFocus(document.body, { showFocus: false });
    returnFocus(document.body, { showFocus: true });
    expect(focus).not.toHaveBeenCalled();
    expect(marked(document.body)).toBe(false);
  });

  it('gives nothing back to an element that has left the page', () => {
    const opener = tile();
    opener.remove();
    const focus = vi.spyOn(opener, 'focus');

    returnFocus(opener, { showFocus: false });

    expect(focus).not.toHaveBeenCalled();
    expect(marked(opener)).toBe(false);
  });
});

describe('showsKeyboardFocus', () => {
  it('says no for an element given focus back quietly', () => {
    const opener = tile();
    opener.setAttribute(QUIET_FOCUS_ATTRIBUTE, '');
    expect(showsKeyboardFocus(opener)).toBe(false);
  });

  it('answers as a browser that cannot tell would: focus goes back as it always has', () => {
    const opener = tile();
    vi.spyOn(opener, 'matches').mockImplementation(() => {
      throw new SyntaxError("':focus-visible' is not a valid selector");
    });
    expect(showsKeyboardFocus(opener)).toBe(true);
  });
});
