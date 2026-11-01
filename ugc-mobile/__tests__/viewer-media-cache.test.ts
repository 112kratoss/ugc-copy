import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersiveSourceData } from '../lib/immersive-preview-source-data';
import { profileFailedGenerationsQueryKey, selectFailedCreations } from '../lib/profile-media-query';
import type { GenerationListItem, GenerationListResponse } from '../lib/types';
import {
  applyGenerationArchiveToCaches,
  refreshViewerMediaCaches,
  removeGenerationFromCaches,
} from '../lib/viewer-media-cache';

const USER = 'owner-1';
const LIBRARY = ['profile-generations', USER];
const PAGE_UPDATED_AT = Date.parse('2026-10-14T08:00:00.000Z');

function creation(id: string, createdAt: string, overrides: Partial<GenerationListItem> = {}): GenerationListItem {
  return {
    id,
    output_url: `https://cdn.test/${id}.png`,
    status: 'succeeded',
    created_at: createdAt,
    model: 'image-model',
    category: 'image',
    archived_at: null,
    ...overrides,
  };
}

/** Two loaded pages, newest first, the second holding the creation a reader scrolled to. */
const firstPage = (): GenerationListResponse => ({
  generations: [creation('new-1', '2026-10-14T07:00:00.000Z'), creation('new-2', '2026-10-14T06:00:00.000Z')],
  pagination: { limit: 24, hasMore: true, nextCursor: '24' },
});
const secondPage = (): GenerationListResponse => ({
  generations: [creation('old-1', '2026-10-01T07:00:00.000Z'), creation('card-40', '2026-10-01T06:00:00.000Z')],
  pagination: { limit: 24, hasMore: false, nextCursor: null },
});

let queryClient: QueryClient;
const api = {
  listGenerations: vi.fn(async () => firstPage()),
  listOwnerPosts: vi.fn(),
  getSavedMedia: vi.fn(),
};

function seed() {
  queryClient.setQueryData<InfiniteData<GenerationListResponse, string | null>>(
    LIBRARY,
    { pages: [firstPage(), secondPage()], pageParams: [null, '24'] },
    { updatedAt: PAGE_UPDATED_AT }
  );
  // The card a reel opened from an alert loaded for itself, and a creation a
  // screen looked up on its own.
  queryClient.setQueryData<ImmersiveSourceData>(
    ['immersive-preview-source', 'studio-creations', USER, 'card-40', '', '', false, ''],
    { generations: [creation('card-40', '2026-10-01T06:00:00.000Z')] },
    { updatedAt: PAGE_UPDATED_AT }
  );
  queryClient.setQueryData(
    ['profile-library-selection', 'profile-creations', USER, 'card-40'],
    creation('card-40', '2026-10-01T06:00:00.000Z'),
    { updatedAt: PAGE_UPDATED_AT }
  );
  queryClient.setQueryData(['showcase-feed', 'for-you', USER], { pages: [], pageParams: [] });
  queryClient.setQueryData(['profile', USER], { id: USER });
}

const libraryIds = () => queryClient.getQueryData<InfiniteData<GenerationListResponse>>(LIBRARY)?.pages
  .map((page) => page.generations.map((item) => item.id));
const archivedAtOf = (id: string) => queryClient.getQueryData<InfiniteData<GenerationListResponse>>(LIBRARY)?.pages
  .flatMap((page) => page.generations)
  .find((item) => item.id === id)?.archived_at;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  api.listGenerations.mockClear();
  seed();
});

afterEach(() => {
  queryClient.clear();
});

describe('an archived or restored creation', () => {
  // Archiving card 40 cut every library to its first 24 and read every page
  // of Explore and Home again (audit 01-8).
  it('changes in the page it is on, and every loaded page stays', async () => {
    await applyGenerationArchiveToCaches({
      api, queryClient, userId: USER, generationId: 'card-40', archivedAt: '2026-10-14T09:00:00.000Z',
    });

    expect(libraryIds()).toEqual([['new-1', 'new-2'], ['old-1', 'card-40']]);
    expect(archivedAtOf('card-40')).toBe('2026-10-14T09:00:00.000Z');
    expect(archivedAtOf('old-1')).toBeNull();
  });

  it('is written into the window a reel loaded for itself and into a creation looked up on its own', async () => {
    await applyGenerationArchiveToCaches({
      api, queryClient, userId: USER, generationId: 'card-40', archivedAt: '2026-10-14T09:00:00.000Z',
    });

    const [, source] = queryClient.getQueriesData<ImmersiveSourceData>({ queryKey: ['immersive-preview-source'] })[0];
    expect(source?.generations?.[0].archived_at).toBe('2026-10-14T09:00:00.000Z');
    expect(queryClient.getQueryData<GenerationListItem>(['profile-library-selection', 'profile-creations', USER, 'card-40'])?.archived_at)
      .toBe('2026-10-14T09:00:00.000Z');
    // Patching one row does not make the rest of a window fresh.
    expect(queryClient.getQueriesData({ queryKey: ['immersive-preview-source'] })
      .map(([key]) => queryClient.getQueryState(key)?.dataUpdatedAt)).toEqual([PAGE_UPDATED_AT]);
  });

  it("reads only the library's first page again, and the profile's counts, and no feed", async () => {
    await applyGenerationArchiveToCaches({
      api, queryClient, userId: USER, generationId: 'card-40', archivedAt: '2026-10-14T09:00:00.000Z',
    });

    expect(api.listGenerations.mock.calls).toEqual([[true, { limit: 24 }]]);
    expect(api.listOwnerPosts).not.toHaveBeenCalled();
    expect(api.getSavedMedia).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(['profile', USER])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['showcase-feed', 'for-you', USER])?.isInvalidated).toBe(false);
    expect(queryClient.getQueriesData({ queryKey: ['immersive-preview-source'] })
      .every(([key]) => !queryClient.getQueryState(key)?.isInvalidated)).toBe(true);
  });

  it('comes back from a restore the same way', async () => {
    await applyGenerationArchiveToCaches({
      api, queryClient, userId: USER, generationId: 'card-40', archivedAt: '2026-10-14T09:00:00.000Z',
    });
    await applyGenerationArchiveToCaches({ api, queryClient, userId: USER, generationId: 'card-40', archivedAt: null });

    expect(archivedAtOf('card-40')).toBeNull();
    expect(libraryIds()).toEqual([['new-1', 'new-2'], ['old-1', 'card-40']]);
  });

  it('keeps the change in the pages when the first page cannot be read again', async () => {
    api.listGenerations.mockRejectedValueOnce(new Error('Network request failed'));

    await applyGenerationArchiveToCaches({
      api, queryClient, userId: USER, generationId: 'card-40', archivedAt: '2026-10-14T09:00:00.000Z',
    });

    expect(archivedAtOf('card-40')).toBe('2026-10-14T09:00:00.000Z');
  });
});

describe('a deleted creation', () => {
  it('leaves every cache that lists it, the pages around it staying put', () => {
    queryClient.setQueryData(['owner-generation-details', USER, 'card-40'], creation('card-40', '2026-10-01T06:00:00.000Z'));

    removeGenerationFromCaches(queryClient, USER, 'card-40');

    expect(libraryIds()).toEqual([['new-1', 'new-2'], ['old-1']]);
    const [, source] = queryClient.getQueriesData<ImmersiveSourceData>({ queryKey: ['immersive-preview-source'] })[0];
    expect(source?.generations).toEqual([]);
    expect(queryClient.getQueryData(['profile-library-selection', 'profile-creations', USER, 'card-40'])).toBeNull();
    expect(queryClient.getQueryState(['owner-generation-details', USER, 'card-40'])).toBeUndefined();
    expect(api.listGenerations).not.toHaveBeenCalled();
  });

  it('is known gone to the lookup a screen opened on it makes, which then asks the server nothing', () => {
    queryClient.removeQueries({ queryKey: ['profile-library-selection'] });

    removeGenerationFromCaches(queryClient, USER, 'card-40');

    const lookup = queryClient.getQueryState(['profile-library-selection', 'profile-creations', USER, 'card-40']);
    expect(lookup).toMatchObject({ status: 'success', data: null });
  });

  it('leaves other people and other creations alone', () => {
    removeGenerationFromCaches(queryClient, USER, 'not-listed');

    expect(libraryIds()).toEqual([['new-1', 'new-2'], ['old-1', 'card-40']]);
    expect(queryClient.getQueryState(LIBRARY)?.dataUpdatedAt).toBe(PAGE_UPDATED_AT);
  });
});

describe("the Failed scope's pages", () => {
  const FAILED = profileFailedGenerationsQueryKey(USER);
  const failure = (id: string, createdAt: string) => creation(id, createdAt, { status: 'failed', output_url: null });
  const failedPages = (): InfiniteData<GenerationListResponse, string | null> => ({
    pages: [
      { generations: [failure('failed-1', '2026-10-14T05:00:00.000Z')], pagination: { limit: 24, hasMore: true, nextCursor: '24' } },
      { generations: [failure('failed-25', '2026-09-01T05:00:00.000Z')], pagination: { limit: 24, hasMore: false, nextCursor: null } },
    ],
    pageParams: [null, '24'],
  });
  const failedIds = () => selectFailedCreations(
    queryClient.getQueryData<InfiniteData<GenerationListResponse>>(FAILED)?.pages.flatMap((page) => page.generations) ?? [],
  ).map((item) => item.id);

  beforeEach(() => {
    api.listGenerations.mockImplementation(async (_includeArchived?: boolean, options?: { status?: string }) => (
      options?.status === 'failed' ? failedPages().pages[0] : firstPage()
    ));
    queryClient.setQueryData(FAILED, failedPages(), { updatedAt: PAGE_UPDATED_AT });
  });

  afterEach(() => {
    api.listGenerations.mockImplementation(async () => firstPage());
  });

  it('lose a failure archived from them, the pages around it staying put', async () => {
    await applyGenerationArchiveToCaches({
      api, queryClient, userId: USER, generationId: 'failed-25', archivedAt: '2026-10-14T09:00:00.000Z',
    });

    expect(failedIds()).toEqual(['failed-1']);
    expect(queryClient.getQueryData<InfiniteData<GenerationListResponse>>(FAILED)?.pages).toHaveLength(2);
  });

  it('read their first page again after an archive or a restore, which can bring a failure back', async () => {
    await applyGenerationArchiveToCaches({ api, queryClient, userId: USER, generationId: 'failed-25', archivedAt: null });

    expect(api.listGenerations.mock.calls).toEqual([[true, { limit: 24 }], [false, { limit: 24, status: 'failed' }]]);
  });

  it('are not read for a reader who never opened the scope', async () => {
    queryClient.removeQueries({ queryKey: FAILED });

    await applyGenerationArchiveToCaches({
      api, queryClient, userId: USER, generationId: 'card-40', archivedAt: '2026-10-14T09:00:00.000Z',
    });

    expect(api.listGenerations.mock.calls).toEqual([[true, { limit: 24 }]]);
    expect(queryClient.getQueryState(FAILED)).toBeUndefined();
  });

  it('lose a deleted failure', () => {
    removeGenerationFromCaches(queryClient, USER, 'failed-25');

    expect(failedIds()).toEqual(['failed-1']);
    expect(api.listGenerations).not.toHaveBeenCalled();
  });

  it('collapse to their first page and are read again with every profile library', async () => {
    await refreshViewerMediaCaches(queryClient, USER);

    expect(queryClient.getQueryData<InfiniteData<GenerationListResponse>>(FAILED)?.pages).toHaveLength(1);
    expect(queryClient.getQueryState(FAILED)?.isInvalidated).toBe(true);
  });
});
