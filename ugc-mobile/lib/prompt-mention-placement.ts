/**
 * Where a prompt's @ menu goes inside the prompt's card, as the web's menu goes under the line the
 * mention is typed on (`placeMentionMenu` in `src/lib/textarea-caret.ts`).
 *
 * The web's menu may hang past its field into the page; the app's stays inside the prompt's card,
 * and inside the part of the card the keyboard leaves in view. A list drawn under the card (the
 * app's until 2026-11-10) sat behind the keyboard, and reaching its rows meant scrolling the page
 * with the keyboard up. The page scrolls only the caret's line above the keys, not the whole card
 * (iOS's `automaticallyAdjustKeyboardInsets`, Android's `bringPointIntoView`), so on a short phone,
 * or with the card low on the page, the card's foot is behind the keys too: `visibleBottom` says
 * where they start, and the menu goes over the line when there is more room there.
 *
 * All lengths are points in the card's own coordinates: 0 is the card's top edge, as `onLayout`
 * reports a child's place in it.
 */
export type PromptMentionMenuPlacement =
  /** Hung from `top`, under the mention's line. */
  | { side: 'below'; top: number; maxHeight: number | null }
  /**
   * Stood on `foot`, over the mention's line: the menu's foot is placed, not its top, so a menu
   * whose rows change between two measures still ends on the line instead of covering it.
   */
  | { side: 'above'; foot: number; maxHeight: number | null };

/** Between the mention's line and the menu. */
export const PROMPT_MENTION_MENU_GAP = 4;
/** Kept clear between the menu and the card's top and bottom edges, or the keyboard's top. */
export const PROMPT_MENTION_MENU_EDGE = 6;

export function placePromptMentionMenu({
  line,
  field,
  cardHeight,
  visibleBottom = null,
  menuHeight,
  gap = PROMPT_MENTION_MENU_GAP,
  edge = PROMPT_MENTION_MENU_EDGE,
}: {
  /** The mention's line inside the field's text, from its top: where the field draws it once scrolled. */
  line: { top: number; height: number };
  /** The field's box inside the card. */
  field: { top: number; height: number };
  cardHeight: number;
  /** Where the keyboard's top crosses the card, or null with no keyboard over it. */
  visibleBottom?: number | null;
  /** The menu's whole height, before any is taken away. */
  menuHeight: number;
  gap?: number;
  edge?: number;
}): PromptMentionMenuPlacement {
  // A line scrolled out of the field hangs the menu from the field's nearer edge, as on the web.
  const lineTopInField = Math.min(Math.max(line.top, 0), Math.max(field.height - line.height, 0));
  const lineTop = field.top + lineTopInField;
  const lineBottom = lineTop + line.height;
  const floor = visibleBottom === null ? cardHeight : Math.min(cardHeight, visibleBottom);
  const below = Math.max(floor - edge - lineBottom - gap, 0);
  const above = Math.max(lineTop - gap - edge, 0);
  if (menuHeight <= below || below >= above) {
    return { side: 'below', top: lineBottom + gap, maxHeight: menuHeight <= below ? null : below };
  }
  return { side: 'above', foot: lineTop - gap, maxHeight: menuHeight <= above ? null : above };
}

/**
 * Where the prompt's paragraph around `offset` ends: the next line break, or the prompt's end.
 *
 * The menu's measuring copy of the prompt runs to here rather than to the caret, so it breaks its
 * lines as the field does: a field wraps a mention with what follows it ("@ali, then…") and
 * Android's line breaker weighs a whole paragraph, so a copy cut at the caret could put the
 * caret's line one higher than the field draws it.
 */
export function promptParagraphEnd(text: string, offset: number) {
  const at = text.indexOf('\n', offset);
  return at === -1 ? text.length : at;
}

/**
 * Which laid-out line holds the character at `offset`, from each line's text (`onTextLayout`
 * gives every line with its trailing spaces and break, so their lengths add up to the text's).
 * Past the end, or where the lengths fall short, it is the last line.
 */
export function lineIndexAtOffset(lines: readonly { text: string }[], offset: number) {
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    start += lines[index].text.length;
    if (offset < start) return index;
  }
  return lines.length - 1;
}
