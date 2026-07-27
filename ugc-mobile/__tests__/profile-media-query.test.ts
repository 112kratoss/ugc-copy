import { describe, expect, it } from 'vitest';

import {
  flattenProfileGenerationPages,
  flattenProfileOwnerPostPages,
  getNextProfileGenerationsCursor,
  getNextProfileOwnerPostsOffset,
  getNextProfileSavedMediaOffset,
  truncateInfiniteDataToFirstPage,
} from '../lib/profile-media-query';

function generationPage(ids: string[], pagination?: { hasMore: boolean; nextCursor: string | null }) {
  return {
    generations: ids.map((id) => ({ id, output_url: null })),
    ...(pagination ? { pagination: { limit: 24, ...pagination } } : {}),
  } as never;
}

function ownerPostPage(ids: string[], pageInfo?: { hasMore: boolean; nextOffset: number | null }) {
  return {
    success: true,
    posts: ids.map((id) => ({ id })),
    ...(pageInfo ? { pageInfo: { limit: 24, offset: 0, ...pageInfo } } : {}),
  } as never;
}

function savedPage(ids: string[], pageInfo?: { hasMore: boolean; nextOffset: number | null }) {
  return {
    items: ids.map((id) => ({ id })),
    ...(pageInfo ? { pageInfo: { limit: 24, offset: 0, ...pageInfo } } : {}),
  } as never;
}

describe('profile media pagination', () => {
  it('stops paging when the server reports no more rows', () => {
    expect(getNextProfileGenerationsCursor(
      generationPage(['a'], { hasMore: false, nextCursor: null })
    )).toBeUndefined();
    expect(getNextProfileOwnerPostsOffset(
      ownerPostPage(['a'], { hasMore: false, nextOffset: null })
    )).toBeUndefined();
    expect(getNextProfileSavedMediaOffset(
      savedPage(['a'], { hasMore: false, nextOffset: null })
    )).toBeUndefined();
  });

  it('follows the cursor or offset the server hands back', () => {
    expect(getNextProfileGenerationsCursor(
      generationPage(['a'], { hasMore: true, nextCursor: '24' })
    )).toBe('24');
    expect(getNextProfileOwnerPostsOffset(
      ownerPostPage(['a'], { hasMore: true, nextOffset: 24 })
    )).toBe(24);
    expect(getNextProfileSavedMediaOffset(
      savedPage(['a'], { hasMore: true, nextOffset: 24 })
    )).toBe(24);
  });

  it('keeps paging when a page arrives empty but more rows remain', () => {
    // Every endpoint filters rows after cutting the page, so an empty page is not the end.
    expect(getNextProfileGenerationsCursor(
      generationPage([], { hasMore: true, nextCursor: '48' })
    )).toBe('48');
    expect(getNextProfileOwnerPostsOffset(
      ownerPostPage([], { hasMore: true, nextOffset: 48 })
    )).toBe(48);
    expect(getNextProfileSavedMediaOffset(
      savedPage([], { hasMore: true, nextOffset: 48 })
    )).toBe(48);
  });

  it('treats a missing pagination block as the end of the list', () => {
    expect(getNextProfileGenerationsCursor(generationPage(['a']))).toBeUndefined();
    expect(getNextProfileOwnerPostsOffset(ownerPostPage(['a']))).toBeUndefined();
    expect(getNextProfileSavedMediaOffset(savedPage(['a']))).toBeUndefined();
  });

  it('stops when hasMore is true but the server gives no next pointer', () => {
    expect(getNextProfileGenerationsCursor(
      generationPage(['a'], { hasMore: true, nextCursor: null })
    )).toBeUndefined();
    expect(getNextProfileOwnerPostsOffset(
      ownerPostPage(['a'], { hasMore: true, nextOffset: null })
    )).toBeUndefined();
  });

  it('flattens pages in order and drops rows repeated across pages', () => {
    const generations = flattenProfileGenerationPages([
      generationPage(['a', 'b']),
      generationPage(['b', 'c']),
    ]);
    expect(generations.map((item) => item.id)).toEqual(['a', 'b', 'c']);

    const posts = flattenProfileOwnerPostPages([
      ownerPostPage(['p1', 'p2']),
      ownerPostPage(['p2', 'p3']),
    ]);
    expect(posts.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('flattens undefined pages to an empty list', () => {
    expect(flattenProfileGenerationPages(undefined)).toEqual([]);
    expect(flattenProfileOwnerPostPages(undefined)).toEqual([]);
  });

  it('collapses a loaded query back to its first page', () => {
    const loaded = {
      pages: [generationPage(['a']), generationPage(['b']), generationPage(['c'])],
      pageParams: [null, '24', '48'],
    };

    const truncated = truncateInfiniteDataToFirstPage(loaded);

    expect(truncated?.pages).toHaveLength(1);
    expect(truncated?.pageParams).toEqual([null]);
    // The original is left untouched.
    expect(loaded.pages).toHaveLength(3);
  });

  it('leaves an empty or missing cache alone', () => {
    expect(truncateInfiniteDataToFirstPage(undefined)).toBeUndefined();
    const empty = { pages: [], pageParams: [] };
    expect(truncateInfiniteDataToFirstPage(empty)).toBe(empty);
  });
});
