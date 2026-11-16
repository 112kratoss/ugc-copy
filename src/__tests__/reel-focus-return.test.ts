import { afterEach, describe, expect, it, vi } from 'vitest';

import { QUIET_FOCUS_ATTRIBUTE, returnFocus, showsKeyboardFocus } from '@/app/showcase/reel-focus-return';

// Focus goes back to what opened a reel when it closes, shown only as it showed when the reel
// opened (review of #834: a reel opened with the pointer and closed with Escape left its tile's
// controls on). tests/e2e/explore-reel-open.spec.ts draws both paths in Chromium; here the parts a
// browser cannot be asked to switch: what focus() is called with, and the mark where focus() cannot
// be told to hide.

function tile(): HTMLButtonElement {
  const button = document.createElement('button');
  button.textContent = 'Harbour in the rain';
  document.body.append(button);
  return button;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('returnFocus', () => {
  it('gives focus back as it was to a reel opened from the keyboard', () => {
    const opener = tile();
    const focus = vi.spyOn(opener, 'focus');

    returnFocus(opener, { showFocus: true });

    expect(focus).toHaveBeenCalledWith();
    expect(document.activeElement).toBe(opener);
    expect(opener.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(false);
  });

  it('tells focus() not to show it where the browser takes focusVisible, and marks nothing', () => {
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

    expect(calls.at(-1)).toEqual({ preventScroll: true, focusVisible: false });
    expect(document.activeElement).toBe(opener);
    expect(opener.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(false);
  });

  describe('where focus() cannot be told (jsdom reads no focusVisible)', () => {
    it('marks the element until the reader tabs on', () => {
      const opener = tile();

      returnFocus(opener, { showFocus: false });

      expect(document.activeElement).toBe(opener);
      expect(opener.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(true);
      expect(showsKeyboardFocus(opener)).toBe(false);

      // Activating it is no move onwards.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(opener.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(true);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      expect(opener.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(false);
    });

    it('takes the mark off on an arrow key, or when focus leaves the element', () => {
      const first = tile();
      returnFocus(first, { showFocus: false });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(first.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(false);

      const second = tile();
      returnFocus(second, { showFocus: false });
      expect(second.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(true);
      second.blur();
      expect(second.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(false);
    });

    it('marks an element once however often focus goes back to it', () => {
      const opener = tile();
      const listen = vi.spyOn(window, 'addEventListener');
      const unlisten = vi.spyOn(window, 'removeEventListener');

      returnFocus(opener, { showFocus: false });
      returnFocus(opener, { showFocus: false });

      const added = listen.mock.calls.filter(([type]) => type === 'keydown').length;
      const removed = unlisten.mock.calls.filter(([type]) => type === 'keydown').length;
      expect(added - removed).toBe(1);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      expect(opener.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(false);
    });
  });

  it('gives nothing back to an element that has left the page', () => {
    const opener = tile();
    opener.remove();
    const focus = vi.spyOn(opener, 'focus');

    returnFocus(opener, { showFocus: false });

    expect(focus).not.toHaveBeenCalled();
    expect(opener.hasAttribute(QUIET_FOCUS_ATTRIBUTE)).toBe(false);
  });
});

describe('showsKeyboardFocus', () => {
  it('says no for an element given focus back quietly', () => {
    const opener = tile();
    opener.setAttribute(QUIET_FOCUS_ATTRIBUTE, '');
    expect(showsKeyboardFocus(opener)).toBe(false);
  });

  it("answers as a browser that cannot tell would: focus goes back as it always has", () => {
    const opener = tile();
    vi.spyOn(opener, 'matches').mockImplementation(() => {
      throw new SyntaxError("':focus-visible' is not a valid selector");
    });
    expect(showsKeyboardFocus(opener)).toBe(true);
  });
});
