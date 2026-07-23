import { describe, expect, it } from 'vitest';

import {
  findActiveReferenceMention,
  insertHandleAtSelection,
  normalizeTextSelection,
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
});
