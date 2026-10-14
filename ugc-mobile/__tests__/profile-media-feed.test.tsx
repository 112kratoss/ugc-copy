(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import { Share } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';

/**
 * The profile's Posts feed, rendered only as far as what it hands each card's
 * actions (`callbacksFor`): the cards, the list and the sheets are doubles.
 */

// One router object for every render: a new one per render hangs these suites.
const routerState = vi.hoisted(() => ({
  params: { source: 'profile-posts' } as Record<string, string>,
  back: vi.fn(),
  canGoBack: vi.fn(() => true),
  push: vi.fn(),
  replace: vi.fn(),
}));

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

// One object for every render, as the real context provides.
const authState = vi.hoisted(() => ({
  api: {
    getProfile: vi.fn(),
    shareShowcasePost: vi.fn((_postId: string, _options: { sourceSurface: string }) => Promise.resolve()),
  },
  user: { id: 'owner-1', email: 'owner@example.com' },
}));

const libraryState = vi.hoisted(() => ({ items: [] as unknown[] }));

const feedState = vi.hoisted(() => ({
  callbacksFor: null as null | ((item: unknown) => { onShare: () => void }),
}));

const nothing = vi.hoisted(() => () => null);

vi.mock('expo-router', () => ({
  router: routerState,
  useLocalSearchParams: () => routerState.params,
}));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ getQueryData: vi.fn(), invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

vi.mock('@shopify/flash-list', () => ({ FlashList: nothing }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  ActivityIndicator: nothing,
  Platform: {
    get OS() {
      return platformState.os;
    },
    select: (options: Record<string, unknown>) => options[platformState.os] ?? options.default,
  },
  Pressable: nothing,
  Share: {
    dismissedAction: 'dismissedAction',
    share: vi.fn(),
    sharedAction: 'sharedAction',
  },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: nothing,
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  View: nothing,
}));

vi.mock('lucide-react-native', () => ({ RefreshCw: nothing }));

vi.mock('@/components/viewer-actions-menu', () => ({
  ViewerActionsMenuProvider: ({ callbacksFor }: { callbacksFor: (item: unknown) => { onShare: () => void } }) => {
    feedState.callbacksFor = callbacksFor;
    return null;
  },
}));
vi.mock('@/components/comments-sheet', () => ({ CommentsSheet: nothing }));
vi.mock('@/components/feed-pagination-footer', () => ({ FeedLoadMoreErrorFooter: nothing }));
vi.mock('@/components/media-zoom', () => ({ MediaZoomSurface: nothing }));
vi.mock('@/components/zoom-veil', () => ({ ZoomVeilScope: nothing }));
vi.mock('@/components/profile-feed-card', () => ({ ProfileFeedCardView: nothing }));
vi.mock('@/components/ui', () => ({ SecondaryButton: nothing, StatusBlock: nothing }));
vi.mock('@/components/viewer-action-sheet', () => ({ ViewerActionSheet: nothing }));

vi.mock('@/lib/audio-creation-native-player', () => ({ audioCreationPlayback: { pause: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://magicbooklet.com' } }));
vi.mock('@/lib/platform-glyphs', () => ({ BackGlyph: nothing }));
vi.mock('@/lib/safe-area', () => ({
  resolvedBottomInset: (inset: number) => inset,
  resolvedTopInset: (inset: number) => inset,
}));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({ colors: { background: '#fff', muted: '#666', primary: '#f60', text: '#111' } }),
}));
vi.mock('@/lib/post-lifecycle', () => ({
  changePostVisibility: vi.fn(),
  pickPostVisibility: vi.fn(),
  resolveLinkedLifecyclePost: vi.fn(),
  toPostLifecyclePost: (post: unknown) => post,
}));
vi.mock('@/lib/profile-feed-card-view-model', () => ({
  INITIAL_FEED_LANDING: { phase: 'idle', targetIndex: -1 },
  buildProfileFeedCards: (items: Array<{ id: string }>) => items.map((item) => ({ id: item.id, item })),
  reduceFeedLanding: (state: unknown) => state,
  shouldScrollToFeedTarget: () => false,
}));
vi.mock('@/lib/profile-library-head', () => ({ refreshProfileLibraryHead: vi.fn() }));
vi.mock('@/lib/use-profile-library-source', () => ({
  useProfileLibrarySource: () => ({
    enrichmentFailed: false,
    fetchNextPage: vi.fn(),
    hasData: true,
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isLoading: false,
    isStale: false,
    items: libraryState.items,
    pageCount: 1,
    refetch: vi.fn(),
    retryEnrichment: vi.fn(),
    retrySelection: vi.fn(),
    selection: 'none',
  }),
}));
vi.mock('@/lib/use-profile-media-revalidation', () => ({ useProfileMediaRevalidation: () => undefined }));
vi.mock('@/lib/viewer-media-cache', () => ({ applyPostVisibilityToCaches: vi.fn() }));

import { ProfileMediaFeedScreen } from '@/components/profile-media-feed';

/** One of the owner's public posts, as the Posts library lists it. */
const publicPost = {
  id: 'post-1',
  source: 'profile-posts',
  sourceType: 'owner-post',
  title: 'Neon alley',
  canShare: true,
  sharePath: '/showcase/post-1',
  showcasePostId: 'post-1',
  ownerPostId: 'post-1',
  generationId: null,
  mediaItems: [],
  availableActions: ['share'],
} as unknown as ImmersivePreviewItem;

const trees: renderer.ReactTestRenderer[] = [];

function renderFeed() {
  act(() => {
    trees.push(renderer.create(<ProfileMediaFeedScreen />));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  platformState.os = 'ios';
  libraryState.items = [publicPost];
  feedState.callbacksFor = null;
});

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
});

describe("the profile feed's Share", () => {
  // Android's share intent answers "shared" whether or not anything was sent
  // (`invite.tsx`), so only iOS can count a share (audit 04-4).
  it.each([
    ['android', 'sharedAction', false],
    ['ios', 'sharedAction', true],
    ['ios', 'dismissedAction', false],
  ] as const)('on %s, a sheet that answers %s counts a share: %s', async (os, action, counted) => {
    platformState.os = os;
    renderFeed();
    vi.mocked(Share.share).mockResolvedValueOnce({ action: Share[action] } as never);

    await act(async () => {
      feedState.callbacksFor!(publicPost).onShare();
    });

    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/showcase/post-1'),
    }));
    expect(authState.api.shareShowcasePost.mock.calls).toEqual(
      counted ? [['post-1', { sourceSurface: 'my-creations' }]] : []
    );
  });

  it('counts nothing and throws nothing when the sheet fails to open', async () => {
    renderFeed();
    vi.mocked(Share.share).mockRejectedValueOnce(new Error('No activity found to handle Intent'));

    await act(async () => {
      feedState.callbacksFor!(publicPost).onShare();
    });

    expect(authState.api.shareShowcasePost).not.toHaveBeenCalled();
  });
});
