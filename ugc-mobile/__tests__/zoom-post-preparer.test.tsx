import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';

type PagePrefetch = {
  queryKey: unknown;
  initialPageParam: number;
  staleTime: number;
  queryFn: (context: { pageParam: number }) => Promise<unknown>;
};

const { state } = vi.hoisted(() => ({
  state: {
    user: { id: 'reader' } as { id: string } | null,
    preparer: null as ((post: ImmersivePreviewItem) => void) | null,
    prefetched: [] as unknown[],
    pagePrefetches: [] as PagePrefetch[],
    mutating: 0,
    api: {
      getCreatorFollowState: (() => undefined) as (...args: unknown[]) => unknown,
      getCreatorProfile: (() => undefined) as (...args: unknown[]) => unknown,
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
vi.mock('@tanstack/react-query', () => ({
  skipToken: Symbol('skipToken'),
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({
    prefetchQuery: async ({ queryKey }: { queryKey: unknown }) => {
      state.prefetched.push(queryKey);
    },
    prefetchInfiniteQuery: async (options: PagePrefetch) => {
      state.pagePrefetches.push(options);
    },
    // No creator page cached: every answer is asked for.
    getQueriesData: () => [],
    getQueryState: () => undefined,
    isMutating: () => state.mutating,
    setQueryData: vi.fn(),
  }),
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

function post(creatorId: string, sourceType: ImmersivePreviewItem['sourceType'] = 'showcase') {
  return { id: `post-by-${creatorId}`, creatorId, sourceType } as ImmersivePreviewItem;
}

function mount() {
  let tree: renderer.ReactTestRenderer | null = null;
  renderer.act(() => {
    tree = renderer.create(<ZoomPostPreparer />);
  });
  return tree!;
}

afterEach(() => {
  state.user = { id: 'reader' };
  state.preparer = null;
  state.prefetched = [];
  state.pagePrefetches = [];
  state.mutating = 0;
});

describe('ZoomPostPreparer', () => {
  it("asks whom the reader follows for another creator's post, and nothing for their own", () => {
    const tree = mount();

    state.preparer?.(post('creator-9'));
    state.preparer?.(post('reader'));
    state.preparer?.(post('creator-9', 'generation'));

    expect(state.prefetched).toEqual([['creator-follow-state', 'creator-9']]);
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
      const getCreatorProfile = vi.fn(async () => ({}));
      state.api.getCreatorProfile = getCreatorProfile;
      const tree = mount();

      prepareCreatorProfile('luna');

      // The page's own query: its key, its page size, its minute of freshness.
      expect(state.pagePrefetches.map((options) => options.queryKey)).toEqual([['creator-profile', 'infinite', 'luna']]);
      const [options] = state.pagePrefetches;
      expect(options).toMatchObject({ initialPageParam: 0, staleTime: 60_000 });
      await options.queryFn({ pageParam: 0 });
      expect(getCreatorProfile).toHaveBeenCalledWith('luna', { limit: 24, offset: 0 });

      renderer.act(() => tree.unmount());
      prepareCreatorProfile('luna');
      expect(state.pagePrefetches).toHaveLength(1);
    },
  );

  // A Follow pressed in the reel, say: a page read under it can carry the
  // answer from before it.
  it('reads nothing while a change is on its way', () => {
    state.mutating = 1;
    const tree = mount();

    prepareCreatorProfile('luna');

    expect(state.pagePrefetches).toEqual([]);
    renderer.act(() => tree.unmount());
  });
});
