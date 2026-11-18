import { readFileSync } from 'node:fs';
import path from 'node:path';

import postcss, { type Rule } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SCROLLBAR_ROOM_ATTRIBUTE, SCROLLBAR_ROOM_RESTORE } from '@/lib/scrollbar-room-restore';

// Where scrollbars take room beside the page, a page moved sideways by half of one when its
// scrollbar came (Alerts, 7.5px: sweep of 2026-11-17). The root layout marks such a browser before
// the first paint, and the stylesheet keeps the room open under the mark only: scrollbars laid over
// the page take none, and a gutter kept for them would narrow every page for nothing. The browser
// end is tests/e2e/scrollbar-room.spec.ts; jsdom lays nothing out, so a case says what a scrollbar
// takes.

const root = document.documentElement;

function restore() {
  new Function(SCROLLBAR_ROOM_RESTORE)();
}

/** A browser whose scrollbar takes `room` pixels of a box that scrolls. */
function scrollbarsTaking(room: number) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(100 - room);
}

afterEach(() => {
  root.removeAttribute(SCROLLBAR_ROOM_ATTRIBUTE);
  vi.restoreAllMocks();
});

describe('the scrollbar room mark', () => {
  it('marks the root where a scrollbar takes room beside the page, and leaves nothing behind', () => {
    const children = document.body.childElementCount;
    scrollbarsTaking(15);
    restore();
    expect(root.hasAttribute(SCROLLBAR_ROOM_ATTRIBUTE)).toBe(true);
    expect(document.body.childElementCount).toBe(children);
  });

  it('leaves the root unmarked where scrollbars are laid over the page', () => {
    scrollbarsTaking(0);
    restore();
    expect(root.hasAttribute(SCROLLBAR_ROOM_ATTRIBUTE)).toBe(false);
  });

  it('never stops the page when it cannot measure', () => {
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('no elements here');
    });
    expect(restore).not.toThrow();
    expect(root.hasAttribute(SCROLLBAR_ROOM_ATTRIBUTE)).toBe(false);
  });

  it('keeps the window\'s scrollbar room open under the mark only', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    const selectors: string[] = [];
    postcss.parse(css).walkDecls('scrollbar-gutter', (declaration) => {
      const rule = declaration.parent as Rule;
      if (rule.parent?.type === 'root') selectors.push(...rule.selectors);
    });
    expect(selectors).toEqual([`html[${SCROLLBAR_ROOM_ATTRIBUTE}]`]);
  });
});
