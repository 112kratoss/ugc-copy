import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { GenerationListItem, OwnerPostsResponse, ShowcaseFeedResponse } from '../lib/types';
import { describe, expect, it, vi } from 'vitest';

import {
  PROFILE_RENDERING_REFRESH_INTERVAL_MS,
  flattenProfileGenerationPages,
  flattenProfileOwnerPostPages,
  formatRenderingStartedLabel,
  getNextProfileGenerationsCursor,
  getNextProfileOwnerPostsOffset,
  getNextProfileSavedMediaOffset,
  invalidateProfileCreations,
  selectFailedCreations,
  selectRenderingCreations,
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

it('uses server cursor boundaries, including empty filtered pages, and stops at an explicit null', () => {
  const owner = { success: true, posts: [], pageInfo: { hasMore: true, nextOffset: 24, offset: 0, limit: 24, nextCursor: 'owner-boundary' } } as OwnerPostsResponse;
  const saved = { items: [], pageInfo: { hasMore: true, nextOffset: 24, offset: 0, limit: 24, nextCursor: 'save-boundary' } } as ShowcaseFeedResponse;
  expect(getNextProfileOwnerPostsOffset(owner)).toBe('owner-boundary');
  expect(getNextProfileSavedMediaOffset(saved)).toBe('save-boundary');
  expect(getNextProfileOwnerPostsOffset({ ...owner, pageInfo: { ...owner.pageInfo!, nextCursor: null } })).toBeUndefined();
});

function run(id: string, overrides: Partial<GenerationListItem>): GenerationListItem {
  return {
    id,
    output_url: null,
    status: 'processing',
    created_at: '2026-10-13T10:00:00Z',
    model: 'kling-3.0-video',
    category: 'video',
    ...overrides,
  };
}

describe('the Rendering strip', () => {
  it('takes every run still in flight, in the library order, and nothing settled or archived', () => {
    const items = [
      run('queued', { status: 'pending' }),
      run('done', { status: 'succeeded', output_url: 'done.mp4' }),
      run('waiting', { status: 'waiting' }),
      run('failed', { status: 'failed' }),
      run('working', { status: 'processing' }),
      run('archived', { status: 'processing', archived_at: '2026-10-13T10:05:00Z' }),
    ];

    expect(selectRenderingCreations(items).map((item) => item.id)).toEqual(['queued', 'waiting', 'working']);
  });

  it('says how long ago a run started', () => {
    const startedAt = '2026-10-13T10:00:00Z';
    const at = (minutes: number) => Date.parse(startedAt) + minutes * 60_000;

    expect(formatRenderingStartedLabel(startedAt, at(0.5))).toBe('Started just now');
    expect(formatRenderingStartedLabel(startedAt, at(1))).toBe('Started 1 min ago');
    expect(formatRenderingStartedLabel(startedAt, at(59.9))).toBe('Started 59 min ago');
    expect(formatRenderingStartedLabel(startedAt, at(125))).toBe('Started 2 h ago');
    // A phone clock behind the server's is not a negative age.
    expect(formatRenderingStartedLabel(startedAt, at(-3))).toBe('Started just now');
    expect(formatRenderingStartedLabel(null, at(3))).toBe('Started recently');
    expect(formatRenderingStartedLabel('not a date', at(3))).toBe('Started recently');
  });

  it('refreshes every 15 seconds', () => {
    expect(PROFILE_RENDERING_REFRESH_INTERVAL_MS).toBe(15_000);
  });
});

describe('the Failed strip', () => {
  // `isCreationLibraryMember` keeps failed runs out of the grid; the strip is
  // where they are listed instead (audit 01-9).
  it('takes every failed run that is not archived, in the library order, and nothing else', () => {
    const items = [
      run('lost', { status: 'failed' }),
      run('working', { status: 'processing' }),
      run('done', { status: 'succeeded', output_url: 'done.mp4' }),
      run('tidied', { status: 'failed', archived_at: '2026-10-13T10:05:00Z' }),
      run('later', { status: 'failed', category: 'image' }),
      run('queued', { status: 'pending' }),
    ];

    expect(selectFailedCreations(items).map((item) => item.id)).toEqual(['lost', 'later']);
  });
});

describe('invalidateProfileCreations', () => {
  const key = (userId: string) => ['profile-generations', userId];
  const library = { pages: [{ generations: [] }], pageParams: [null] };

  function watchedLibrary(userId: string) {
    const queryClient = new QueryClient();
    const queryFn = vi.fn(async () => library);
    queryClient.setQueryData(key(userId), library);
    // An observer that is mounted and fresh, as Profile's grid is in a tab.
    const observer = new QueryObserver(queryClient, { queryKey: key(userId), queryFn, staleTime: 60_000 });
    const unsubscribe = observer.subscribe(() => undefined);
    return { queryClient, queryFn, unsubscribe };
  }

  it('marks the reader’s creations stale without fetching anything now', async () => {
    const { queryClient, queryFn, unsubscribe } = watchedLibrary('user-1');
    queryClient.setQueryData(key('user-2'), library);

    await invalidateProfileCreations(queryClient, 'user-1');

    expect(queryClient.getQueryState(key('user-1'))?.isInvalidated).toBe(true);
    expect(queryFn).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(key('user-2'))?.isInvalidated).toBe(false);
    unsubscribe();
  });

  it('is told apart from an invalidation that refetches, which this observer would see', async () => {
    const { queryClient, queryFn, unsubscribe } = watchedLibrary('user-1');

    await queryClient.invalidateQueries({ queryKey: key('user-1') });

    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('does nothing without a signed-in user', async () => {
    const queryClient = { invalidateQueries: vi.fn() };

    await invalidateProfileCreations(queryClient, null);
    await invalidateProfileCreations(queryClient, undefined);

    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});
