/**
 * Where a textarea draws one of its characters, and where a menu hung from it fits.
 *
 * The creators' "@" menu hangs under the line the mention is typed on, as the
 * app's list sits under its prompt and as a mention menu does in Slack or GitHub.
 * A textarea says nothing about where its text is laid out, so the text is laid
 * out again in a hidden copy that takes the textarea's font, padding and width,
 * and the character is read where it lands there.
 */

export type TextareaCaret = {
  /** The top of the character's line, from the textarea's top edge, after its own scroll. */
  top: number;
  /** The character's left edge, from the textarea's left edge, after its own scroll. */
  left: number;
  /** One line's height. */
  height: number;
};

// What decides where the text wraps and how tall a line is.
const MIRRORED_PROPERTIES = [
  'direction',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'font-stretch',
  'font-feature-settings',
  'font-kerning',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-transform',
  'text-indent',
  'text-align',
  'tab-size',
  'white-space',
  'word-break',
  'overflow-wrap',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const;

/** Measures where the character at `index` of `textarea` is drawn. */
export function measureTextareaCaret(textarea: HTMLTextAreaElement, index: number): TextareaCaret {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  for (const property of MIRRORED_PROPERTIES) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  // The text's own width: the textarea's inside, less its padding and any scrollbar.
  const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    visibility: 'hidden',
    boxSizing: 'content-box',
    width: `${Math.max(0, textarea.clientWidth - paddingX)}px`,
    border: '0',
    overflow: 'hidden',
  });

  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(index) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const fontSize = parseFloat(style.fontSize) || 16;
  const height = parseFloat(style.lineHeight) || fontSize * 1.2;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  // An inline box starts a little below its line's top, by half the leading, so the
  // line is found by rounding to the line grid.
  const line = Math.max(0, Math.round((marker.offsetTop - paddingTop) / height));
  const caret = {
    top: (parseFloat(style.borderTopWidth) || 0) + paddingTop + line * height - textarea.scrollTop,
    left: (parseFloat(style.borderLeftWidth) || 0) + marker.offsetLeft - textarea.scrollLeft,
    height,
  };
  mirror.remove();
  return caret;
}

export type MentionMenuPlacement = {
  /** From the textarea's top edge. */
  top: number;
  /** From the textarea's left edge. */
  left: number;
  /** A height to hold the menu to, or null where it fits as it is. */
  maxHeight: number | null;
  side: 'below' | 'above';
};

/**
 * Where the menu goes: under the line it was typed on, starting at the "@", and
 * over that line instead when the window has more room there than under it (the
 * prompt near the window's foot, or a phone's keyboard up). It never leaves the
 * textarea's width.
 */
export function placeMentionMenu({
  caret,
  fieldWidth,
  menuWidth,
  menuHeight,
  room,
  gap = 6,
  minHeight = 120,
}: {
  caret: TextareaCaret;
  fieldWidth: number;
  menuWidth: number;
  /** The menu's whole height, before any is taken away. */
  menuHeight: number;
  /** What the window shows above the caret's line and below it. */
  room: { above: number; below: number };
  gap?: number;
  minHeight?: number;
}): MentionMenuPlacement {
  // The menu's edge a little before the "@", so its rows' pictures sit under the mention.
  const left = Math.min(Math.max(caret.left - 8, 0), Math.max(fieldWidth - menuWidth, 0));
  const below = room.below - gap;
  const above = room.above - gap;
  if (menuHeight <= below || below >= above) {
    return {
      top: caret.top + caret.height + gap,
      left,
      maxHeight: menuHeight <= below ? null : Math.max(below, minHeight),
      side: 'below',
    };
  }
  const height = Math.min(menuHeight, Math.max(above, minHeight));
  return {
    top: caret.top - gap - height,
    left,
    maxHeight: height < menuHeight ? height : null,
    side: 'above',
  };
}
