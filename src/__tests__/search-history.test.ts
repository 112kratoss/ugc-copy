import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SEARCH_HISTORY_OWNER_KEY,
  clearSearchHistory,
  forgetSearchQuery,
  readSearchHistory,
  rememberSearchQuery,
} from '@/components/search/search-history';

const HISTORY_KEY = 'magicbooklet:public-search-history:v1';
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

// The web's recent searches: this browser's localStorage, the rules the app's
// list follows, and an end at sign-out wherever the sign-out happened.
describe('web recent searches', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps a search under the shared rules and reads it back', () => {
    expect(rememberSearchQuery('  kling   portrait ', null)).toEqual(['kling portrait']);
    expect(rememberSearchQuery('neon harbor', null)).toEqual(['neon harbor', 'kling portrait']);
    // A longer query replaces the step on the way to it; one too short is not kept.
    expect(rememberSearchQuery('neon harbor at dusk', null)).toEqual(['neon harbor at dusk', 'kling portrait']);
    expect(rememberSearchQuery('n', null)).toEqual(['neon harbor at dusk', 'kling portrait']);
    expect(readSearchHistory(null)).toEqual(['neon harbor at dusk', 'kling portrait']);
    expect(forgetSearchQuery('KLING portrait', null)).toEqual(['neon harbor at dusk']);
    expect(clearSearchHistory()).toEqual([]);
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('ends an account’s list when that account is no longer the one in the browser', () => {
    rememberSearchQuery('kling portrait', ACCOUNT);
    expect(window.localStorage.getItem(SEARCH_HISTORY_OWNER_KEY)).toBe(ACCOUNT);
    expect(readSearchHistory(ACCOUNT)).toEqual(['kling portrait']);

    // Signed out on another page or in another tab: the next read finds nothing, and nothing is left.
    expect(readSearchHistory(null)).toEqual([]);
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
    expect(window.localStorage.getItem(SEARCH_HISTORY_OWNER_KEY)).toBeNull();
    // It does not come back for the account either: it was cleared, not hidden.
    expect(readSearchHistory(ACCOUNT)).toEqual([]);
  });

  it('never shows one account’s list to the next account', () => {
    rememberSearchQuery('kling portrait', ACCOUNT);
    expect(readSearchHistory(OTHER)).toEqual([]);
    expect(rememberSearchQuery('veo ocean', OTHER)).toEqual(['veo ocean']);
    expect(window.localStorage.getItem(SEARCH_HISTORY_OWNER_KEY)).toBe(OTHER);
    // Removing or adding as the wrong account starts from nothing too.
    expect(forgetSearchQuery('veo ocean', ACCOUNT)).toEqual([]);
  });

  it('keeps a visitor’s list through a sign-in, as the app does, and it becomes the account’s at its next search', () => {
    rememberSearchQuery('kling portrait', null);
    expect(window.localStorage.getItem(SEARCH_HISTORY_OWNER_KEY)).toBeNull();
    expect(readSearchHistory(ACCOUNT)).toEqual(['kling portrait']);
    expect(rememberSearchQuery('veo ocean', ACCOUNT)).toEqual(['veo ocean', 'kling portrait']);
    expect(window.localStorage.getItem(SEARCH_HISTORY_OWNER_KEY)).toBe(ACCOUNT);
    expect(readSearchHistory(null)).toEqual([]);
  });

  it('reads the account from the session cookie when it is not told, and nobody from none', () => {
    // No session cookie in this document: a list an account kept is gone.
    rememberSearchQuery('kling portrait', ACCOUNT);
    expect(readSearchHistory()).toEqual([]);
  });

  it('works the same with storage that throws, as a private window can', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readSearchHistory(ACCOUNT)).toEqual([]);
    expect(rememberSearchQuery('kling portrait', ACCOUNT)).toEqual(['kling portrait']);
    expect(forgetSearchQuery('kling portrait', ACCOUNT)).toEqual([]);
    expect(clearSearchHistory()).toEqual([]);
    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
  });
});
