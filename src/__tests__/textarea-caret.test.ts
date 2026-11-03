import { describe, expect, it } from 'vitest';

import { measureTextareaCaret, placeMentionMenu } from '@/lib/textarea-caret';

const caret = { top: 48, left: 120, height: 24 };

describe('placeMentionMenu', () => {
  it('hangs the menu under the line it was typed on, from just before the "@"', () => {
    expect(placeMentionMenu({ caret, fieldWidth: 600, menuWidth: 352, menuHeight: 200, room: { above: 300, below: 400 } })).toEqual({
      top: 48 + 24 + 6,
      left: 112,
      maxHeight: null,
      side: 'below',
    });
  });

  it('keeps the menu inside the field\'s width', () => {
    expect(placeMentionMenu({ caret: { ...caret, left: 500 }, fieldWidth: 600, menuWidth: 352, menuHeight: 200, room: { above: 0, below: 400 } }).left).toBe(248);
    expect(placeMentionMenu({ caret: { ...caret, left: 4 }, fieldWidth: 600, menuWidth: 352, menuHeight: 200, room: { above: 0, below: 400 } }).left).toBe(0);
    // A field narrower than the menu: the menu is the field's width, from its edge.
    expect(placeMentionMenu({ caret, fieldWidth: 300, menuWidth: 300, menuHeight: 200, room: { above: 0, below: 400 } }).left).toBe(0);
  });

  it('goes over the line when the window has more room there', () => {
    expect(placeMentionMenu({ caret, fieldWidth: 600, menuWidth: 352, menuHeight: 200, room: { above: 500, below: 120 } })).toEqual({
      top: 48 - 6 - 200,
      left: 112,
      maxHeight: null,
      side: 'above',
    });
  });

  it('takes the height away where neither side holds it', () => {
    // More room under the line: the menu stays there, as tall as the room.
    expect(placeMentionMenu({ caret, fieldWidth: 600, menuWidth: 352, menuHeight: 288, room: { above: 150, below: 206 } })).toMatchObject({
      side: 'below',
      maxHeight: 200,
    });
    // More over it: the menu goes there, as tall as that room.
    expect(placeMentionMenu({ caret, fieldWidth: 600, menuWidth: 352, menuHeight: 288, room: { above: 206, below: 150 } })).toEqual({
      top: 48 - 6 - 200,
      left: 112,
      maxHeight: 200,
      side: 'above',
    });
    // Never shorter than a row or two.
    expect(placeMentionMenu({ caret, fieldWidth: 600, menuWidth: 352, menuHeight: 288, room: { above: 20, below: 40 } }).maxHeight).toBe(120);
  });
});

describe('measureTextareaCaret', () => {
  it('reads a line from the textarea\'s own style, after its scroll, and leaves nothing behind', () => {
    const textarea = document.createElement('textarea');
    textarea.style.lineHeight = '24px';
    textarea.style.paddingTop = '8px';
    textarea.style.borderTopWidth = '1px';
    textarea.style.borderTopStyle = 'solid';
    textarea.value = 'A harbour at dusk with @';
    document.body.appendChild(textarea);
    const before = document.body.childElementCount;

    expect(measureTextareaCaret(textarea, textarea.value.length - 1)).toMatchObject({ top: 9, height: 24 });
    Object.defineProperty(textarea, 'scrollTop', { configurable: true, value: 4 });
    expect(measureTextareaCaret(textarea, textarea.value.length - 1).top).toBe(5);
    expect(document.body.childElementCount).toBe(before);
    textarea.remove();
  });
});
