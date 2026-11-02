import { describe, expect, it } from 'vitest';

import {
  findActiveReferenceMention,
  insertHandleAtSelection,
  normalizeTextSelection,
  referenceMatchesMention,
  selectionAfterTextChange,
} from '../lib/reference-mentions';

describe('reference mentions', () => {
  it('finds an empty or filtered mention at the caret', () => {
    expect(findActiveReferenceMention('Use @', { start: 5, end: 5 })).toEqual({ start: 4, end: 5, query: '' });
    expect(findActiveReferenceMention('Use @flo', { start: 8, end: 8 })).toEqual({ start: 4, end: 8, query: 'flo' });
  });

  it('does not suggest inside email-like text, selected text, or the middle of a handle', () => {
    const email = 'artist@example';
    expect(findActiveReferenceMention(email, { start: email.length, end: email.length })).toBeNull();
    expect(findActiveReferenceMention('Use @flo', { start: 4, end: 8 })).toBeNull();
    expect(findActiveReferenceMention('Use @flowers', { start: 8, end: 8 })).toBeNull();
  });

  it('offers a reference to a mention by its handle or its name, in any case, and never one with no handle', () => {
    const flowers = { handle: '@flowers', displayName: 'Spring bouquet' };
    expect(referenceMatchesMention(flowers, '')).toBe(true);
    expect(referenceMatchesMention(flowers, 'FLO')).toBe(true);
    expect(referenceMatchesMention(flowers, 'bouq')).toBe(true);
    expect(referenceMatchesMention(flowers, 'rose')).toBe(false);
    expect(referenceMatchesMention({ handle: null, displayName: 'Flowers' }, 'flo')).toBe(false);
  });

  it('inserts handles at the beginning, middle, and end with natural spacing', () => {
    expect(insertHandleAtSelection('Product on stone', '@flowers', { start: 0, end: 0 })).toEqual({
      text: '@flowers Product on stone',
      selection: { start: 9, end: 9 },
    });
    expect(insertHandleAtSelection('Place beside the vase.', '@flowers', { start: 13, end: 13 })).toEqual({
      text: 'Place beside @flowers the vase.',
      selection: { start: 22, end: 22 },
    });
    expect(insertHandleAtSelection('Use soft light', '@flowers', { start: 14, end: 14 })).toEqual({
      text: 'Use soft light @flowers',
      selection: { start: 23, end: 23 },
    });
  });

  it('replaces the active query or a selected range without disturbing surrounding copy', () => {
    expect(insertHandleAtSelection('Use @flo for color', '@flowers', { start: 4, end: 8 })).toEqual({
      text: 'Use @flowers for color',
      selection: { start: 12, end: 12 },
    });
    expect(insertHandleAtSelection('Use the red vase.', '@flowers', { start: 8, end: 11 })).toEqual({
      text: 'Use the @flowers vase.',
      selection: { start: 16, end: 16 },
    });
  });

  it('clamps stale or reversed selections to the current prompt', () => {
    expect(normalizeTextSelection('short', { start: 99, end: 2 })).toEqual({ start: 2, end: 5 });
  });

  it('moves a caret with the words around it when the prompt changes from outside the field', () => {
    const caret = (at: number) => ({ start: at, end: at });
    // A saved draft filling the empty field the composer mounted on.
    expect(selectionAfterTextChange('', 'A cat on a sofa', caret(0))).toEqual(caret(15));
    // A rename before the caret, and one after it.
    expect(selectionAfterTextChange('Place @flowers beside the vase', 'Place @roses beside the vase', caret(22))).toEqual(caret(20));
    expect(selectionAfterTextChange('Place beside @flowers', 'Place beside @roses', caret(6))).toEqual(caret(6));
    // A caret right after the renamed handle stays right after it.
    expect(selectionAfterTextChange('Use @flowers for color', 'Use @roses for color', caret(12))).toEqual(caret(10));
    // A removed handle before the caret.
    expect(selectionAfterTextChange('Place @flowers beside the vase', 'Place beside the vase', caret(22))).toEqual(caret(13));
    // Enhance and Undo rewrite the words the caret ended: it ends the new ones.
    expect(selectionAfterTextChange('A cat', 'A fluffy cat sitting on a sofa', caret(5))).toEqual(caret(30));
    expect(selectionAfterTextChange('A fluffy cat sitting on a sofa', 'A cat', caret(30))).toEqual(caret(5));
    // Unchanged text keeps its caret, and a selection keeps both of its ends.
    expect(selectionAfterTextChange('Same words', 'Same words', caret(4))).toEqual(caret(4));
    expect(selectionAfterTextChange('Place @flowers beside the vase', 'Place @roses beside the vase', { start: 0, end: 5 })).toEqual({ start: 0, end: 5 });
  });
});
