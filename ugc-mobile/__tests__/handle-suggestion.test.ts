import { describe, expect, it } from 'vitest';

import { firstHandleSuggestion, handleForTypedName, numberedHandleSuggestion } from '../lib/handle-suggestion';

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
