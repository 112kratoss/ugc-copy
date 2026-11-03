import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryArgs = {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
  staleTime: number;
  retry: (failureCount: number, error: unknown) => boolean;
};

const { state } = vi.hoisted(() => ({
  state: {
    queryArgs: null as QueryArgs | null,
    query: { data: undefined as unknown, isPending: true },
    getShowcasePost: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (args: QueryArgs) => {
    state.queryArgs = args;
    return state.query;
  },
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ api: { getShowcasePost: state.getShowcasePost } }),
}));

import { ApiError } from '@/lib/api-client';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { usePostGenerationSetup } from '@/lib/use-post-generation-setup';

const IMAGE_SETUP = [
  { label: 'Aspect ratio', value: '9:16' },
  { label: 'Resolution', value: '1K' },
];

function feedItem(overrides: Partial<ImmersivePreviewItem> = {}, details: Record<string, unknown> = {}): ImmersivePreviewItem {
  return {
    id: 'post-1',
    sourceType: 'showcase',
    showcasePostId: 'post-1',
    generationId: 'gen-1',
    details: { title: 'Harbour', model: 'nano-banana-2', ...details },
    ...overrides,
  } as unknown as ImmersivePreviewItem;
}

let latest: ReturnType<typeof usePostGenerationSetup> | null = null;

function Host({ item, active }: { item: ImmersivePreviewItem; active: boolean }) {
  latest = usePostGenerationSetup(item, active);
  return null;
}

function render(item: ImmersivePreviewItem, active = true) {
  act(() => {
    renderer.create(React.createElement(Host, { item, active }));
  });
  return latest!;
}

describe('usePostGenerationSetup', () => {
  beforeEach(() => {
    state.queryArgs = null;
    state.query = { data: undefined, isPending: true };
    state.getShowcasePost.mockReset();
    latest = null;
  });

  it('reads a feed post once Details is on screen, holding the line until the settings come', async () => {
    const pending = render(feedItem(), false);
    expect(state.queryArgs).toMatchObject({ queryKey: ['post-generation-setup', 'post-1'], enabled: false, staleTime: Infinity });
    expect(pending).toEqual({ entries: [], pending: true });

    render(feedItem(), true);
    expect(state.queryArgs?.enabled).toBe(true);

    // The post's own read, and only its settings, malformed pairs dropped.
    state.getShowcasePost.mockResolvedValue({ success: true, item: { id: 'post-1', generationSetup: [...IMAGE_SETUP, { label: 'Seed' }] } });
    await expect(state.queryArgs!.queryFn()).resolves.toEqual(IMAGE_SETUP);
    expect(state.getShowcasePost).toHaveBeenCalledWith('post-1');
    // A server from before the setup was public sends none.
    state.getShowcasePost.mockResolvedValue({ success: true, item: { id: 'post-1' } });
    await expect(state.queryArgs!.queryFn()).resolves.toEqual([]);

    state.query = { data: IMAGE_SETUP, isPending: false };
    expect(render(feedItem())).toEqual({ entries: IMAGE_SETUP, pending: false });
  });

  it('lets the line go when the read fails, and asks again only after a dropped connection', () => {
    state.query = { data: undefined, isPending: false };
    expect(render(feedItem())).toEqual({ entries: [], pending: false });

    expect(state.queryArgs!.retry(0, new Error('Network request failed'))).toBe(true);
    expect(state.queryArgs!.retry(1, new Error('Network request failed'))).toBe(false);
    expect(state.queryArgs!.retry(0, new ApiError('Post not found.', 404))).toBe(false);
  });

  it('draws the settings a post brought, reading nothing', () => {
    expect(render(feedItem({}, { generationSetup: IMAGE_SETUP }))).toEqual({ entries: IMAGE_SETUP, pending: false });
    expect(state.queryArgs?.enabled).toBe(false);
    expect(render(feedItem({}, { generationSetup: [] }))).toEqual({ entries: [], pending: false });
    expect(state.queryArgs?.enabled).toBe(false);
  });

  it('reads nothing and holds no line for a post with none to show', () => {
    for (const item of [
      feedItem({ generationId: null }),
      feedItem({}, { model: 'template-workflow' }),
      feedItem({ previewKind: 'text' }, { generationSetup: IMAGE_SETUP }),
      feedItem({ sourceType: 'owner-post' }),
    ]) {
      expect(render(item)).toEqual({ entries: [], pending: false });
      expect(state.queryArgs?.enabled).toBe(false);
    }
  });
});
