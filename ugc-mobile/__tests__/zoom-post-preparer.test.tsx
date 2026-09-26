import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';

const { state } = vi.hoisted(() => ({
  state: {
    user: { id: 'reader' } as { id: string } | null,
    preparer: null as ((post: ImmersivePreviewItem) => void) | null,
    prefetched: [] as unknown[],
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
  }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: state.user, api: { getCreatorFollowState: vi.fn() } }),
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
