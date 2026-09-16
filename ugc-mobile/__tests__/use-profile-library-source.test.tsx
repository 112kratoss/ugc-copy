(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useProfileLibrarySource } from '../lib/use-profile-library-source';
import type { GenerationListItem, GenerationListResponse, OwnerPostListItem, OwnerPostsResponse } from '../lib/types';

type LibraryProps = Parameters<typeof useProfileLibrarySource>[0];
type LibraryResult = ReturnType<typeof useProfileLibrarySource>;

const owner = { creatorLabel: '@owner', creatorAvatar: null, creatorId: 'user-1' };

function generation(id: string, overrides: Partial<GenerationListItem> = {}): GenerationListItem {
  return {
    id,
    output_url: `https://cdn.example.com/${id}.png`,
    status: 'succeeded',
    created_at: '2026-09-02T10:00:00.000Z',
    model: 'nano-banana-2',
    category: 'image',
    title: id,
    ...overrides,
  };
}

function ownerPost(id: string, overrides: Partial<OwnerPostListItem> = {}): OwnerPostListItem {
  return {
    id,
    title: id,
    createdAt: '2026-09-02T10:00:00.000Z',
    visibility: 'public',
    mediaUrl: `https://cdn.example.com/${id}.png`,
    mediaKind: 'image',
    commentCount: 0,
    category: 'image',
    postFormat: 'media',
    bundle: null,
    ...overrides,
  } as OwnerPostListItem;
}

function generationPage(items: GenerationListItem[], nextCursor: string | null): GenerationListResponse {
  return { generations: items, pagination: { limit: 24, hasMore: Boolean(nextCursor), nextCursor } };
}

function postsPage(posts: OwnerPostListItem[]): OwnerPostsResponse {
  return { success: true, posts, pageInfo: { hasMore: false, nextOffset: null } } as unknown as OwnerPostsResponse;
}

function stubApi(overrides: Partial<Record<'listGenerations' | 'listOwnerPosts' | 'getOwnerPost', unknown>> = {}) {
  return {
    listGenerations: vi.fn(async () => generationPage([], null)),
    listOwnerPosts: vi.fn(async () => postsPage([])),
    getOwnerPost: vi.fn(),
    ...overrides,
  } as unknown as LibraryProps['api'] & Record<'listGenerations' | 'listOwnerPosts' | 'getOwnerPost', ReturnType<typeof vi.fn>>;
}

async function renderLibrary(props: Omit<LibraryProps, 'owner' | 'userId'>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const latest: { current: LibraryResult | null } = { current: null };

  function Probe() {
    latest.current = useProfileLibrarySource({ ...props, owner, userId: 'user-1' });
    return null;
  }

  await renderer.act(async () => {
    renderer.create(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  });

  return {
    latest,
    async until(predicate: (result: LibraryResult) => boolean) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (latest.current && predicate(latest.current)) return latest.current;
        await renderer.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      throw new Error(`Library never reached the expected state: ${JSON.stringify({
        selection: latest.current?.selection,
        ids: latest.current?.items.map((item) => item.id),
      })}`);
    },
  };
}

describe('useProfileLibrarySource', () => {
  it('reports an initial read failure and can retry the primary library', async () => {
    const api = stubApi({ listGenerations: vi.fn()
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValue(generationPage([generation('tapped')], null)) });
    const library = await renderLibrary({ api, source: 'profile-creations', initialId: 'tapped' });
    const failed = await library.until((result) => result.isError);
    expect(failed.selection).toBe('error');
    expect(failed.isLoading).toBe(false);
    await renderer.act(async () => { await failed.refetch(); });
    const ready = await library.until((result) => result.selection === 'found');
    expect(ready.items.map((item) => item.id)).toEqual(['tapped']);
    expect(api.getOwnerPost).not.toHaveBeenCalled();
  });

  it('keeps a delayed selected lookup distinct from a failed primary read', async () => {
    let finish!: (value: GenerationListResponse) => void;
    const api = stubApi({ listGenerations: vi.fn(async (_archived, options) => options.id
      ? new Promise<GenerationListResponse>((resolve) => { finish = resolve; })
      : generationPage([generation('unrelated')], null)) });
    const library = await renderLibrary({ api, source: 'profile-creations', initialId: 'older' });
    const pending = await library.until((result) => result.hasData && Boolean(finish));
    expect(pending.selection).toBe('loading');
    expect(pending.isError).toBe(false);
    await renderer.act(async () => { finish(generationPage([generation('older')], null)); });
    const ready = await library.until((result) => result.selection === 'found');
    expect(ready.items[0].id).toBe('older');
  });

  it('reads the grid\'s pages in the grid\'s order and rule, and continues through its cursor', async () => {
    const firstPage = [
      generation('newest'),
      generation('failed', { status: 'failed', output_url: null }),
      generation('gone', { output_url: null, source_unavailable_at: '2026-09-08T06:15:00.000Z' }),
      generation('tapped'),
    ];
    const api = stubApi({
      listGenerations: vi.fn(async (_includeArchived: boolean, options: { cursor?: string }) => (
        options.cursor === '24' ? generationPage([generation('older')], null) : generationPage(firstPage, '24')
      )),
    });

    const library = await renderLibrary({ api, source: 'profile-creations', initialId: 'tapped' });
    const ready = await library.until((result) => result.selection === 'found');

    expect(api.listGenerations).toHaveBeenCalledWith(false, { cursor: undefined, limit: 24 });
    expect(ready.items.map((item) => item.id)).toEqual(['newest', 'gone', 'tapped']);

    await renderer.act(async () => {
      await library.latest.current!.fetchNextPage();
    });
    const paged = await library.until((result) => result.items.length === 4);
    expect(paged.items.map((item) => item.id)).toEqual(['newest', 'gone', 'tapped', 'older']);
    expect(api.listGenerations).toHaveBeenCalledWith(false, { cursor: '24', limit: 24 });
  });

  it('looks up a selection outside the loaded pages once, and keeps it at the head for the visit', async () => {
    const api = stubApi({
      listGenerations: vi.fn(async (includeArchived: boolean, options: { id?: string; cursor?: string }) => {
        if (options.id) return { generations: [generation('archived-one', { archived_at: '2026-09-10T00:00:00.000Z' })] };
        return options.cursor === '24'
          ? generationPage([generation('archived-one', { archived_at: '2026-09-10T00:00:00.000Z' })], null)
          : generationPage([generation('recent')], '24');
      }),
    });

    const library = await renderLibrary({ api, source: 'profile-creations', initialId: 'archived-one' });
    const found = await library.until((result) => result.selection === 'found');

    expect(api.listGenerations).toHaveBeenCalledWith(true, { id: 'archived-one', limit: 1 });
    expect(found.items.map((item) => item.id)).toEqual(['archived-one', 'recent']);

    await renderer.act(async () => {
      await library.latest.current!.fetchNextPage();
    });
    const paged = await library.until((result) => !result.isFetchingNextPage && result.pageCount === 2);
    expect(paged.items.map((item) => item.id)).toEqual(['archived-one', 'recent']);
  });

  it('reports a selection the owner lookup cannot find as missing, never as another creation', async () => {
    const api = stubApi({
      listGenerations: vi.fn(async (_includeArchived: boolean, options: { id?: string }) => (
        options.id ? { generations: [] } : generationPage([generation('first')], null)
      )),
    });

    const library = await renderLibrary({ api, source: 'profile-creations', initialId: 'deleted' });
    const missing = await library.until((result) => result.selection === 'missing');

    expect(missing.items.map((item) => item.id)).toEqual(['first']);
  });

  it('keeps creations on screen when linked-post enrichment fails', async () => {
    const api = stubApi({
      listGenerations: vi.fn(async () => generationPage([generation('playable', { linked_post_id: 'post-1' })], null)),
      listOwnerPosts: vi.fn(async () => { throw new Error('Internal Server Error'); }),
    });

    const library = await renderLibrary({ api, source: 'profile-creations', initialId: 'playable' });
    const ready = await library.until((result) => result.selection === 'found' && result.enrichmentFailed);

    expect(ready.items.map((item) => item.id)).toEqual(['playable']);
    expect(ready.items[0].linkedPostDetailsLoaded).toBe(false);
  });

  it('holds the posts of the scope the tile was tapped in', async () => {
    const api = stubApi({
      listOwnerPosts: vi.fn(async () => postsPage([
        ownerPost('active-one'),
        ownerPost('archived-one', { archivedAt: '2026-09-10T00:00:00.000Z' }),
        ownerPost('archived-two', { archivedAt: '2026-09-11T00:00:00.000Z' }),
      ])),
    });

    const library = await renderLibrary({ api, source: 'profile-posts', initialId: 'archived-two', postsScope: 'archived' });
    const ready = await library.until((result) => result.selection === 'found');

    expect(ready.items.map((item) => item.id)).toEqual(['archived-one', 'archived-two']);
    expect(api.listGenerations).not.toHaveBeenCalled();
  });
});
