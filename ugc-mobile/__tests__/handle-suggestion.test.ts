import { describe, expect, it } from 'vitest';

import {
  firstHandleSuggestion,
  followNameWithHandleSuggestion,
  handleForTypedName,
  MAX_HANDLE_SUGGESTION_SWAPS,
  numberedHandleSuggestion,
  shouldSwapHandleSuggestion,
  startHandleSuggestion,
  swapHandleSuggestion,
} from '../lib/handle-suggestion';

const PROFILE_HANDLE = /^[a-z0-9-]{3,24}$/;

describe('the handle the creator-name step starts with (owner 11-08)', () => {
  it('comes from the name, else the email', () => {
    expect(firstHandleSuggestion('Kiran Das', 'kiran@example.com')).toBe('kiran-das');
    expect(firstHandleSuggestion('', 'maya.k@example.com')).toBe('maya-k');
  });

  it('passes over a handle the caller knows it cannot have', () => {
    expect(firstHandleSuggestion('Support', 'maya@example.com', (handle) => handle !== 'support')).toBe('maya');
  });

  it('is "creator" and three digits for a name that gives no handle', () => {
    expect(firstHandleSuggestion('ആതിര', null, () => true, () => 0.5)).toBe('creator550');
    expect(firstHandleSuggestion(null, null, () => true, () => 0)).toBe('creator100');
    expect(firstHandleSuggestion(null, null, () => true, () => 0.9999)).toBe('creator999');
  });
});

describe('the next try after a taken suggestion', () => {
  it('adds three digits after a hyphen', () => {
    expect(numberedHandleSuggestion('kiran-das', () => 0.382)).toBe('kiran-das-443');
  });

  it('stays a handle the server accepts, however long the base', () => {
    for (const base of ['a-very-long-creator-name-x', 'abcdefghijklmnopqrstuvwx', 'name-with-trailing-------', '']) {
      for (const roll of [0, 0.5, 0.9999]) {
        const handle = numberedHandleSuggestion(base, () => roll);
        expect(handle).toMatch(PROFILE_HANDLE);
        expect(handle).not.toMatch(/--/);
      }
    }
  });
});

describe('the handle for a display name being typed', () => {
  it('comes from the name alone', () => {
    expect(handleForTypedName('Kiran D')).toBe('kiran-d');
    expect(handleForTypedName('ആതിര')).toBe('');
    expect(handleForTypedName('')).toBe('');
    expect(handleForTypedName('Support', (handle) => handle !== 'support')).toBe('');
  });
});

describe('keeping a suggestion through a visit (review of #735)', () => {
  const at = (value: number) => () => value;

  it('swaps only when nothing holds the field still', () => {
    const s = startHandleSuggestion('kiran');
    const base = { username: 'kiran', taken: true, fieldFocused: false, saving: false };
    expect(shouldSwapHandleSuggestion(s, base)).toBe(true);
    expect(shouldSwapHandleSuggestion(s, { ...base, fieldFocused: true })).toBe(false);
    expect(shouldSwapHandleSuggestion(s, { ...base, saving: true })).toBe(false);
    expect(shouldSwapHandleSuggestion(s, { ...base, taken: false })).toBe(false);
    expect(shouldSwapHandleSuggestion(s, { ...base, username: 'typed' })).toBe(false);
    expect(shouldSwapHandleSuggestion(null, base)).toBe(false);
    expect(shouldSwapHandleSuggestion({ ...s, swaps: MAX_HANDLE_SUGGESTION_SWAPS }, base)).toBe(false);
  });

  it('remembers what was taken and numbers from the plain handle', () => {
    const once = swapHandleSuggestion(startHandleSuggestion('kiran'), at(0.5));
    expect(once).toEqual({ current: 'kiran-550', swaps: 1, taken: ['kiran'] });
    expect(swapHandleSuggestion(once, at(0.1)).current).toBe('kiran-190');
  });

  it('does not bring back a taken handle when the name is edited back', () => {
    const swapped = swapHandleSuggestion(startHandleSuggestion('kiran'), at(0.5));
    const renamed = followNameWithHandleSuggestion(swapped, 'Kiran D', () => true, at(0.2))!;
    expect(renamed.current).toBe('kiran-d');
    const back = followNameWithHandleSuggestion(renamed, 'Kiran', () => true, at(0.2))!;
    expect(back.current).toBe('kiran-280');
    expect(back.swaps).toBe(2);
    expect(followNameWithHandleSuggestion({ ...renamed, swaps: MAX_HANDLE_SUGGESTION_SWAPS }, 'Kiran')).toBeNull();
  });

  it('keeps the handle for a name that makes none, or the same one', () => {
    const s = startHandleSuggestion('kiran');
    expect(followNameWithHandleSuggestion(s, 'ആതിര')).toBeNull();
    expect(followNameWithHandleSuggestion(s, 'Kiran')).toBeNull();
  });
});
