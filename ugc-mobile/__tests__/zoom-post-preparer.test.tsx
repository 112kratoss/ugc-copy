import { MutationObserver, QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import type { CreatorProfileResponse } from '../lib/types';

const { state } = vi.hoisted(() => ({
  state: {
    user: { id: 'reader' } as { id: string } | null,
    preparer: null as ((post: ImmersivePreviewItem) => void) | null,
    api: {
      getCreatorFollowState: vi.fn(),
      getCreatorProfile: vi.fn(),
    },
  },
}));

vi.mock('@/components/media-zoom', () => ({
  setZoomPostPreparer: (preparer: (post: ImmersivePreviewItem) => void) => {
    state.preparer = preparer;
    return () => {
      if (state.preparer === preparer) state.preparer = null;
    };
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: state.user, api: state.api }),
}));
// What the chrome draws is not the subject here, only what the preparer asks for.
vi.mock('@/components/reel-chrome', () => ({ IconShadow: () => null, ReelSlideChrome: () => null }));
vi.mock('@/components/top-scrim', () => ({ TopScrim: () => null }));
vi.mock('@/lib/platform-glyphs', () => ({ BackGlyph: () => null }));
vi.mock('@/lib/safe-area', () => ({ resolvedBottomInset: () => 0, resolvedTopInset: () => 0 }));
vi.mock('@/lib/viewer-audio', () => ({ useViewerAudioMuted: () => false }));
vi.mock('react-native', () => ({ View: () => null }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { ZoomPostPreparer } from '../components/zoom-post-chrome';
import { prepareCreatorProfile } from '../lib/creator-profile-opening';

const MINUTE = 60 * 1000;
const lunaGridKey = ['creator-profile', 'infinite', 'luna'];

function post(creatorId: string, sourceType: ImmersivePreviewItem['sourceType'] = 'showcase') {
  return { id: `post-by-${creatorId}`, creatorId, sourceType } as ImmersivePreviewItem;
}

/** One page of luna's grid, as the server sends it from `offset`. */
function gridPage(offset: number): CreatorProfileResponse {
  return {
    profile: { id: 'creator-1', username: 'luna' },
    items: [],
    pageInfo: { hasMore: offset < 48, nextLimit: null, nextOffset: offset < 48 ? offset + 24 : null, limit: 24, offset },
    viewer: { isOwner: false, isFollowing: false, blockedByViewer: false },
  } as unknown as CreatorProfileResponse;
}

/** Luna's grid as her page keeps it once three pages have loaded. */
function threePageGrid(): InfiniteData<CreatorProfileResponse, number> {
  return { pages: [gridPage(0), gridPage(24), gridPage(48)], pageParams: [0, 24, 48] };
}

// React Query's own client, so what the preparer asks of it is what the app's would do.
let client: QueryClient;

function mount() {
  let tree: renderer.ReactTestRenderer | null = null;
  renderer.act(() => {
    tree = renderer.create(
      <QueryClientProvider client={client}>
        <ZoomPostPreparer />
      </QueryClientProvider>,
    );
  });
  return tree!;
}

async function settle() {
  await renderer.act(async () => {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  state.api.getCreatorFollowState.mockReset().mockResolvedValue({ following: false });
  state.api.getCreatorProfile.mockReset().mockImplementation(async (_username: string, { offset }: { offset: number }) => gridPage(offset));
});

afterEach(() => {
  client.clear();
  state.user = { id: 'reader' };
  state.preparer = null;
});

describe('ZoomPostPreparer', () => {
  it("asks whom the reader follows for another creator's post, and nothing for their own", async () => {
    const tree = mount();

    state.preparer?.(post('creator-9'));
    state.preparer?.(post('reader'));
    state.preparer?.(post('creator-9', 'generation'));
    await settle();

    expect(state.api.getCreatorFollowState.mock.calls).toEqual([['creator-9']]);
    renderer.act(() => tree.unmount());
    expect(state.preparer).toBeNull();
  });

  it('asks nothing for a reader who is not signed in', () => {
    state.user = null;
    mount();

    expect(state.preparer).toBeNull();
  });
});

describe("ZoomPostPreparer, for a creator's page", () => {
  // A guest's touch too: guests open creator pages as members do.
  it.each([['a member', { id: 'reader' }], ['a guest', null]])(
    "reads the page's first page as a finger lands on its creator, for %s",
    async (_reader, user) => {
      state.user = user;
      const tree = mount();

      prepareCreatorProfile('luna');
      await settle();

      // The page's own query: its key and its page size.
      expect(state.api.getCreatorProfile.mock.calls).toEqual([['luna', { limit: 24, offset: 0 }]]);
      expect(client.getQueryData(lunaGridKey)).toEqual({ pages: [gridPage(0)], pageParams: [0] });

      renderer.act(() => tree.unmount());
      client.clear();
      prepareCreatorProfile('luna');
      await settle();
      expect(state.api.getCreatorProfile).toHaveBeenCalledTimes(1);
    },
  );

  // Review of #679: a held grid older than its minute was read again page by
  // page at every touch, three requests here, under any reel reading it. The
  // page refreshes what it holds as it mounts.
  it.each([['older than its minute', 5 * MINUTE], ['still fresh', 10 * 1000]])(
    'reads nothing for a grid the app already holds, %s',
    async (_age, age) => {
      const held = threePageGrid();
      client.setQueryData(lunaGridKey, held, { updatedAt: Date.now() - age });
      mount();

      prepareCreatorProfile('luna');
      await settle();

      expect(state.api.getCreatorProfile).not.toHaveBeenCalled();
      expect(client.getQueryData(lunaGridKey)).toBe(held);
    },
  );

  it('asks once for a read already under way', async () => {
    mount();

    prepareCreatorProfile('luna');
    prepareCreatorProfile('luna');
    await settle();

    expect(state.api.getCreatorProfile).toHaveBeenCalledTimes(1);
  });

  // A Follow pressed in the reel, say: a page read under it can carry the
  // answer from before it.
  it('reads nothing while a change is on its way', async () => {
    void new MutationObserver(client, { mutationFn: () => new Promise(() => undefined) }).mutate();
    expect(client.isMutating()).toBe(1);
    mount();

    prepareCreatorProfile('luna');
    await settle();

    expect(state.api.getCreatorProfile).not.toHaveBeenCalled();
  });
});
