/**
 * Where a prompt's @ menu goes inside the prompt's card, as the web's menu goes under the line the
 * mention is typed on (`placeMentionMenu` in `src/lib/textarea-caret.ts`).
 *
 * The web's menu may hang past its field into the page; the app's stays inside the prompt's card,
 * because the card is the part of the page a phone keeps in view over its keyboard. A list drawn
 * under the card (the app's until 2026-11-10) sat behind the keyboard, and reaching its rows meant
 * scrolling the page with the keyboard up.
 *
 * All lengths are points in the card's own coordinates: 0 is the card's top edge.
 */
export type PromptMentionMenuPlacement = {
  top: number;
  /** A height to hold the menu to, or null where it fits as it is. */
  maxHeight: number | null;
  side: 'below' | 'above';
};

/** Between the mention's line and the menu. */
export const PROMPT_MENTION_MENU_GAP = 4;
/** Kept clear between the menu and the card's top and bottom edges. */
export const PROMPT_MENTION_MENU_EDGE = 6;

export function placePromptMentionMenu({
  line,
  field,
  cardHeight,
  menuHeight,
  gap = PROMPT_MENTION_MENU_GAP,
  edge = PROMPT_MENTION_MENU_EDGE,
}: {
  /** The mention's line inside the field's text, from its top: where the field draws it once scrolled. */
  line: { top: number; height: number };
  /** The field's box inside the card. */
  field: { top: number; height: number };
  cardHeight: number;
  /** The menu's whole height, before any is taken away. */
  menuHeight: number;
  gap?: number;
  edge?: number;
}): PromptMentionMenuPlacement {
  // A line scrolled out of the field hangs the menu from the field's nearer edge, as on the web.
  const lineTopInField = Math.min(Math.max(line.top, 0), Math.max(field.height - line.height, 0));
  const lineTop = field.top + lineTopInField;
  const lineBottom = lineTop + line.height;
  const below = Math.max(cardHeight - edge - lineBottom - gap, 0);
  const above = Math.max(lineTop - gap - edge, 0);
  if (menuHeight <= below || below >= above) {
    return { top: lineBottom + gap, maxHeight: menuHeight <= below ? null : below, side: 'below' };
  }
  const height = Math.min(menuHeight, above);
  return { top: lineTop - gap - height, maxHeight: height < menuHeight ? height : null, side: 'above' };
}
