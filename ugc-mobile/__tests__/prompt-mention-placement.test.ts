import { describe, expect, it } from 'vitest';

import { placePromptMentionMenu } from '../lib/prompt-mention-placement';

// The image composer's card: a 37-point heading, the 190-point field, then the length counter.
const field = { top: 37, height: 190 };
const cardHeight = 260;
const line = (top: number) => ({ top, height: 20 });

describe('placePromptMentionMenu', () => {
  it('hangs the menu under the mention typed on the field’s first line', () => {
    expect(placePromptMentionMenu({ line: line(12), field, cardHeight, menuHeight: 140 })).toEqual({
      top: 37 + 12 + 20 + 4,
      maxHeight: null,
      side: 'below',
    });
  });

  it('holds a menu taller than the room under the line to that room, while that side has more', () => {
    const placed = placePromptMentionMenu({ line: line(12), field, cardHeight, menuHeight: 400 });
    expect(placed.side).toBe('below');
    expect(placed.maxHeight).toBe(260 - 6 - (37 + 12 + 20) - 4);
  });

  it('puts the menu over a mention typed near the field’s foot, where there is more room above', () => {
    const placed = placePromptMentionMenu({ line: line(150), field, cardHeight, menuHeight: 140 });
    expect(placed).toEqual({ top: 37 + 150 - 4 - 140, maxHeight: null, side: 'above' });
  });

  it('holds an over-the-line menu to the room above when it is taller', () => {
    const placed = placePromptMentionMenu({ line: line(150), field, cardHeight, menuHeight: 400 });
    expect(placed.side).toBe('above');
    expect(placed.maxHeight).toBe(37 + 150 - 4 - 6);
    expect(placed.top).toBe(6);
  });

  it('keeps a line the field has scrolled out of view at the field’s nearer edge', () => {
    expect(placePromptMentionMenu({ line: line(-60), field, cardHeight, menuHeight: 100 }).top).toBe(37 + 20 + 4);
    const belowFoot = placePromptMentionMenu({ line: line(400), field, cardHeight, menuHeight: 100 });
    expect(belowFoot).toEqual({ top: 37 + 170 - 4 - 100, maxHeight: null, side: 'above' });
  });

  it('never gives the menu a negative height in a card too short to hold it', () => {
    const placed = placePromptMentionMenu({ line: line(0), field: { top: 0, height: 20 }, cardHeight: 20, menuHeight: 100 });
    expect(placed.maxHeight).toBe(0);
  });
});
