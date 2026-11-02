import { afterEach, describe, expect, it } from 'vitest';

import { isPreviousHistoryEntry } from '@/lib/previous-history-entry';

type TabEntry = string | { path: string; sameDocument: boolean };

// jsdom has no Navigation API: each case puts the tab's entries in place, as
// a browser that has one lists them (this document's own unless one says not).
function stubTabHistory(paths: TabEntry[], currentIndex = paths.length - 1) {
  const entries = paths.map((entry, index) => {
    const { path, sameDocument } = typeof entry === 'string' ? { path: entry, sameDocument: true } : entry;
    return { url: new URL(path, window.location.origin).href, index, sameDocument };
  });
  Object.defineProperty(window, 'navigation', {
    configurable: true,
    value: { currentEntry: entries[currentIndex], entries: () => entries },
  });
}

describe('isPreviousHistoryEntry', () => {
  afterEach(() => {
    delete (window as { navigation?: unknown }).navigation;
  });

  it('is false where the browser has no Navigation API', () => {
    expect(isPreviousHistoryEntry('/creations?view=posts')).toBe(false);
  });

  it('is true when the entry before this one is that address', () => {
    stubTabHistory(['/creations?view=posts&visibility=private', '/post/post-1/edit?from=creations']);

    expect(isPreviousHistoryEntry('/creations?view=posts&visibility=private')).toBe(true);
  });

  it('reads the query whatever its order', () => {
    stubTabHistory(['/creations?visibility=private&view=posts', '/post/post-1/edit']);

    expect(isPreviousHistoryEntry('/creations?view=posts&visibility=private')).toBe(true);
  });

  it('is false for another view of the page, another page, or no entry before', () => {
    stubTabHistory(['/creations?view=posts', '/post/post-1/edit']);
    expect(isPreviousHistoryEntry('/creations?view=posts&visibility=private')).toBe(false);
    expect(isPreviousHistoryEntry('/marketplace/sell')).toBe(false);

    stubTabHistory(['/post/post-1/edit']);
    expect(isPreviousHistoryEntry('/creations?view=posts')).toBe(false);
  });

  // An editor opened by its address or reloaded is a document of its own:
  // Back would load Studio anew, or bring it back from the back-forward cache
  // as it was before the save.
  it('is false for the same address in another document', () => {
    stubTabHistory([{ path: '/creations?view=posts', sameDocument: false }, '/post/post-1/edit']);

    expect(isPreviousHistoryEntry('/creations?view=posts')).toBe(false);
  });

  // Back from an entry other than the last steps to the one before it, not to
  // the last but one.
  it('looks before the current entry, not before the last one', () => {
    stubTabHistory(['/creations', '/post/post-1/edit', '/showcase/post-1'], 1);

    expect(isPreviousHistoryEntry('/creations')).toBe(true);
  });
});
