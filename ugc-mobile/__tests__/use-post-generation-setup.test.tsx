import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryArgs = {
  queryKey: unknown[];
  queryFn: () => Promise<unknown>;
  enabled: boolean;
  staleTime: number;
  retry: (failureCount: number, error: unknown) => boolean;
  retryOnMount: boolean;
  refetchOnWindowFocus: boolean;
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
import { IncompleteAnswerError, ONE_TIME_POST_READ, retryUnlessRefused } from '@/lib/one-time-post-read';
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

  // Feed cards carry the line since #675's review: Details reads nothing for a card that brought it.
  it('draws the settings a card brought, reading nothing', () => {
    expect(render(feedItem({}, { generationSetup: IMAGE_SETUP }))).toEqual({ entries: IMAGE_SETUP, pending: false });
    expect(state.queryArgs?.enabled).toBe(false);
    // A card from a template's result, an upload or a post under its cover brings none.
    expect(render(feedItem({}, { model: 'template-workflow', generationSetup: [] }))).toEqual({ entries: [], pending: false });
    expect(state.queryArgs?.enabled).toBe(false);
  });

  // A card kept from before (Home's first page persists between launches), or one a server could
  // not read the settings for, carries none: Details reads the post once it is on screen.
  it('reads a post whose card came without them, once Details is on screen, holding the line meanwhile', async () => {
    const pending = render(feedItem(), false);
    expect(state.queryArgs).toMatchObject({ queryKey: ['post-generation-setup', 'post-1'], enabled: false });
    expect(pending).toEqual({ entries: [], pending: true });

    render(feedItem(), true);
    expect(state.queryArgs?.enabled).toBe(true);

    // The post's own read, and only its settings, malformed pairs dropped.
    state.getShowcasePost.mockResolvedValue({ success: true, item: { id: 'post-1', generationSetup: [...IMAGE_SETUP, { label: 'Seed' }] } });
    await expect(state.queryArgs!.queryFn()).resolves.toEqual(IMAGE_SETUP);
    expect(state.getShowcasePost).toHaveBeenCalledWith('post-1');
    // None to show is an answer, kept as none.
    state.getShowcasePost.mockResolvedValue({ success: true, item: { id: 'post-1', generationSetup: [] } });
    await expect(state.queryArgs!.queryFn()).resolves.toEqual([]);

    state.query = { data: IMAGE_SETUP, isPending: false };
    expect(render(feedItem())).toEqual({ entries: IMAGE_SETUP, pending: false });
  });

  // The server leaves the field out where it could not read the settings: kept as none, the line
  // would stay away for the session. It fails instead, and is not asked again at once: the same
  // server would answer the same, and each read spends the post read's rate limit.
  it('keeps no answer that could not tell the settings as none, and does not ask again', async () => {
    render(feedItem());
    state.getShowcasePost.mockResolvedValue({ success: true, item: { id: 'post-1' } });
    const failure = await state.queryArgs!.queryFn().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IncompleteAnswerError);
    expect(state.queryArgs!.retry(0, failure)).toBe(false);
  });

  // A failed read is not asked again at every remount and every return to the foreground, where the
  // held line flashed each time: the post read's policy that the remix source row keeps too.
  it("reads once, by the app's one-time post read", () => {
    render(feedItem());
    expect(state.queryArgs).toMatchObject(ONE_TIME_POST_READ);
    expect(state.queryArgs).toMatchObject({ staleTime: Infinity, retryOnMount: false, refetchOnWindowFocus: false });
    expect(state.queryArgs!.retry).toBe(retryUnlessRefused);

    state.query = { data: undefined, isPending: false };
    expect(render(feedItem())).toEqual({ entries: [], pending: false });
  });

  it('asks again only after a dropped connection, once', () => {
    expect(retryUnlessRefused(0, new Error('Network request failed'))).toBe(true);
    expect(retryUnlessRefused(1, new Error('Network request failed'))).toBe(false);
    expect(retryUnlessRefused(0, new ApiError('Post not found.', 404))).toBe(false);
    expect(retryUnlessRefused(0, new ApiError('Busy', 503))).toBe(true);
    expect(retryUnlessRefused(0, new IncompleteAnswerError('The post came back without its settings.'))).toBe(false);
  });

  it('reads nothing and holds no line for a post with none to show', () => {
    for (const item of [
      feedItem({ generationId: null }),
      feedItem({ previewKind: 'text' }, { generationSetup: IMAGE_SETUP }),
      feedItem({ sourceType: 'owner-post' }),
    ]) {
      expect(render(item)).toEqual({ entries: [], pending: false });
      expect(state.queryArgs?.enabled).toBe(false);
    }
  });
});
