import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SEARCH_KEPT_PAGES_KEY,
  SEARCH_KEPT_PAGES_LIMIT,
  SEARCH_KEPT_PAGE_LIFETIME_MS,
  forgetKeptSearchPages,
  keepSearchPage,
  readKeptSearchPage,
} from '@/lib/search-kept-pages';

// What Back and Forward redraw a search from: this tab's, bounded in number
// and in age, the asking account's, in a shape the page draws.

type Answer = { n: number | string };
const isAnswer = (value: unknown): value is Answer => typeof value === 'object' && value !== null && 'n' in value;
const NOW = 1_800_000_000_000;

describe('kept search pages', () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('keeps the last five addresses, most recent first, one entry per address', () => {
    expect(SEARCH_KEPT_PAGES_LIMIT).toBe(5);
    for (let index = 0; index < 7; index += 1) keepSearchPage(`/search?q=q${index}`, { n: index }, index * 10, null, NOW);
    keepSearchPage('/search?q=q6', { n: 'again' }, 99, null, NOW);
    const kept = JSON.parse(window.sessionStorage.getItem(SEARCH_KEPT_PAGES_KEY) ?? '[]') as Array<{ address: string }>;
    expect(kept.map((entry) => entry.address)).toEqual(['/search?q=q6', '/search?q=q5', '/search?q=q4', '/search?q=q3', '/search?q=q2']);
    expect(readKeptSearchPage('/search?q=q6', isAnswer, null, NOW)).toEqual({
      address: '/search?q=q6', answer: { n: 'again' }, scrollY: 99, accountId: null, keptAt: NOW,
    });
    expect(readKeptSearchPage('/search?q=q1', isAnswer, null, NOW)).toBeNull();
  });

  it('draws an answer only for the account it was asked for, and forgets them all at once', () => {
    keepSearchPage('/search?q=cat', { n: 1 }, 10, 'user-1', NOW);
    expect(readKeptSearchPage('/search?q=cat', isAnswer, 'user-1', NOW)?.answer).toEqual({ n: 1 });
    // A sign-out (no account now) or another account: not drawn.
    expect(readKeptSearchPage('/search?q=cat', isAnswer, null, NOW)).toBeNull();
    expect(readKeptSearchPage('/search?q=cat', isAnswer, 'user-2', NOW)).toBeNull();
    // A visitor's answer is not drawn for an account either.
    keepSearchPage('/search?q=dog', { n: 2 }, 10, null, NOW);
    expect(readKeptSearchPage('/search?q=dog', isAnswer, 'user-1', NOW)).toBeNull();
    forgetKeptSearchPages();
    expect(readKeptSearchPage('/search?q=cat', isAnswer, 'user-1', NOW)).toBeNull();
  });

  it('draws nothing older than half an hour, and drops it at the next write', () => {
    expect(SEARCH_KEPT_PAGE_LIFETIME_MS).toBe(30 * 60 * 1000);
    keepSearchPage('/search?q=old', { n: 1 }, 0, null, NOW);
    expect(readKeptSearchPage('/search?q=old', isAnswer, null, NOW + SEARCH_KEPT_PAGE_LIFETIME_MS - 1)).not.toBeNull();
    expect(readKeptSearchPage('/search?q=old', isAnswer, null, NOW + SEARCH_KEPT_PAGE_LIFETIME_MS)).toBeNull();
    keepSearchPage('/search?q=new', { n: 2 }, 0, null, NOW + SEARCH_KEPT_PAGE_LIFETIME_MS);
    const kept = JSON.parse(window.sessionStorage.getItem(SEARCH_KEPT_PAGES_KEY) ?? '[]') as Array<{ address: string }>;
    expect(kept.map((entry) => entry.address)).toEqual(['/search?q=new']);
  });

  it('draws nothing in a shape the page does not draw, nor an entry of the first format', () => {
    keepSearchPage('/search?q=shape', { other: true }, 0, null, NOW);
    expect(readKeptSearchPage('/search?q=shape', isAnswer, null, NOW)).toBeNull();
    // v1 named no asking account and no time: a tab that spans the deploy reads none of it.
    window.sessionStorage.setItem('magicbooklet:search-kept-pages:v1', JSON.stringify([{ address: '/search?q=v1', answer: { n: 1 }, scrollY: 0, accountId: null }]));
    expect(readKeptSearchPage('/search?q=v1', isAnswer, null, NOW)).toBeNull();
    window.sessionStorage.setItem(SEARCH_KEPT_PAGES_KEY, JSON.stringify([{ address: '/search?q=v1', answer: { n: 1 }, scrollY: 0, accountId: null }]));
    expect(readKeptSearchPage('/search?q=v1', isAnswer, null, NOW)).toBeNull();
  });

  it('keeps the top for a scroll that is not a number', () => {
    keepSearchPage('/search?q=nan', { n: 1 }, Number.NaN, null, NOW);
    expect(readKeptSearchPage('/search?q=nan', isAnswer, null, NOW)?.scrollY).toBe(0);
  });

  it('works without a store, and drops the oldest until a full store takes the write', () => {
    keepSearchPage('/search?q=a', { n: 1 }, 0, null, NOW);
    keepSearchPage('/search?q=b', { n: 2 }, 0, null, NOW);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((_key: string, value: string) => {
      if ((JSON.parse(value) as unknown[]).length > 2) throw new DOMException('full', 'QuotaExceededError');
    });
    keepSearchPage('/search?q=c', { n: 3 }, 0, null, NOW);
    expect(setItem).toHaveBeenCalledTimes(2);
    setItem.mockRestore();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readKeptSearchPage('/search?q=a', isAnswer, null, NOW)).toBeNull();
    expect(() => keepSearchPage('/search?q=d', { n: 4 }, 0, null, NOW)).not.toThrow();
  });

  it('reads nothing from a store that holds no list', () => {
    window.sessionStorage.setItem(SEARCH_KEPT_PAGES_KEY, '{"not":"a list"}');
    expect(readKeptSearchPage('/search?q=a', isAnswer, null, NOW)).toBeNull();
    window.sessionStorage.setItem(SEARCH_KEPT_PAGES_KEY, 'not json');
    expect(readKeptSearchPage('/search?q=a', isAnswer, null, NOW)).toBeNull();
  });
});
