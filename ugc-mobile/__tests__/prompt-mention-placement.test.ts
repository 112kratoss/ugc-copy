import { describe, expect, it } from 'vitest';

import { lineIndexAtOffset, placePromptMentionMenu, promptParagraphEnd } from '../lib/prompt-mention-placement';

// The image composer's card: a 37-point heading, the 190-point field, then the length counter.
const field = { top: 37, height: 190 };
const cardHeight = 260;
const line = (top: number) => ({ top, height: 20 });

describe('placePromptMentionMenu', () => {
  it('hangs the menu under the mention typed on the field’s first line', () => {
    expect(placePromptMentionMenu({ line: line(12), field, cardHeight, menuHeight: 140 })).toEqual({
      side: 'below',
      top: 37 + 12 + 20 + 4,
      maxHeight: null,
    });
  });

  it('holds a menu taller than the room under the line to that room, while that side has more', () => {
    const placed = placePromptMentionMenu({ line: line(12), field, cardHeight, menuHeight: 400 });
    expect(placed).toEqual({ side: 'below', top: 73, maxHeight: 260 - 6 - (37 + 12 + 20) - 4 });
  });

  it('stands the menu on the line of a mention typed near the field’s foot, where there is more room above', () => {
    expect(placePromptMentionMenu({ line: line(150), field, cardHeight, menuHeight: 140 })).toEqual({
      side: 'above',
      foot: 37 + 150 - 4,
      maxHeight: null,
    });
  });

  it('holds an over-the-line menu to the room above when it is taller', () => {
    const placed = placePromptMentionMenu({ line: line(150), field, cardHeight, menuHeight: 400 });
    expect(placed).toEqual({ side: 'above', foot: 183, maxHeight: 37 + 150 - 4 - 6 });
  });

  it('keeps a line the field has scrolled out of view at the field’s nearer edge', () => {
    expect(placePromptMentionMenu({ line: line(-60), field, cardHeight, menuHeight: 100 })).toMatchObject({ side: 'below', top: 37 + 20 + 4 });
    expect(placePromptMentionMenu({ line: line(400), field, cardHeight, menuHeight: 100 })).toEqual({
      side: 'above',
      foot: 37 + 170 - 4,
      maxHeight: null,
    });
  });

  // The page scrolls only the caret's line above the keys: on a short phone the rest of the card
  // is behind them, and the menu hung under the line was drawn there (PR #759's review).
  it('goes over the line when the keyboard covers the room under it', () => {
    // The keyboard's top crosses the card 30 points under the second line.
    const placed = placePromptMentionMenu({ line: line(32), field, cardHeight, visibleBottom: 37 + 32 + 20 + 30, menuHeight: 140 });
    expect(placed).toEqual({ side: 'above', foot: 37 + 32 - 4, maxHeight: 37 + 32 - 4 - 6 });
  });

  it('measures the room under the line to the keyboard, not to the card’s foot', () => {
    const placed = placePromptMentionMenu({ line: line(12), field, cardHeight, visibleBottom: 200, menuHeight: 140 });
    expect(placed).toEqual({ side: 'below', top: 73, maxHeight: 200 - 6 - 69 - 4 });
  });

  it('ignores a keyboard whose top is under the card', () => {
    expect(placePromptMentionMenu({ line: line(12), field, cardHeight, visibleBottom: 900, menuHeight: 140 }))
      .toEqual(placePromptMentionMenu({ line: line(12), field, cardHeight, menuHeight: 140 }));
  });

  it('never gives the menu a negative height in a card too short to hold it', () => {
    const placed = placePromptMentionMenu({ line: line(0), field: { top: 0, height: 20 }, cardHeight: 20, menuHeight: 100 });
    expect(placed.maxHeight).toBe(0);
  });
});

describe('promptParagraphEnd', () => {
  it('runs to the next line break after the caret, or to the prompt’s end', () => {
    expect(promptParagraphEnd('Use @ali, then\nwave', 8)).toBe(14);
    expect(promptParagraphEnd('Use @ali, then wave', 8)).toBe(19);
    expect(promptParagraphEnd('line\n@', 6)).toBe(6);
  });
});

describe('lineIndexAtOffset', () => {
  // As onTextLayout gives them: each line with its trailing space and break.
  const lines = [{ text: 'Change the first person to ' }, { text: '@ali second person\n' }, { text: '@' }];

  it('finds the line that holds a character from the lines’ lengths', () => {
    expect(lineIndexAtOffset(lines, 0)).toBe(0);
    expect(lineIndexAtOffset(lines, 26)).toBe(0);
    expect(lineIndexAtOffset(lines, 27)).toBe(1);
    expect(lineIndexAtOffset(lines, 45)).toBe(1);
    expect(lineIndexAtOffset(lines, 46)).toBe(2);
  });

  it('falls back to the last line past the lines’ end', () => {
    expect(lineIndexAtOffset(lines, 400)).toBe(2);
    expect(lineIndexAtOffset([], 3)).toBe(-1);
  });
});
